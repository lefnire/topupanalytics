import {UAParser} from 'ua-parser-js';
import { APIGatewayProxyHandlerV2 } from "aws-lambda"; // Use V2 event type
import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import {
  DynamoDBClient,
  ConditionalCheckFailedException, // Import the exception
  ReturnValue, // Import ReturnValue enum
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand, // Import UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import {
  colsCompliant,
  colsAll as colsAll_, 
  isCompliant, 
  ONLY_COMPLIANT,
  initialColsAll,
  eventsColsAll
} from './schema'
import {log} from './utils'

const colsAll = Object.fromEntries(colsAll_.map(c => [c, true]));
const initialColsMap = Object.fromEntries(initialColsAll.map(c => [c, true]));
const eventsColsMap = Object.fromEntries(eventsColsAll.map(c => [c, true]));

// Initialize Firehose client
const firehoseClient = new FirehoseClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVENTS_FIREHOSE_STREAM_NAME = process.env.EVENTS_FIREHOSE_STREAM_NAME;
const INITIAL_EVENTS_FIREHOSE_STREAM_NAME = process.env.INITIAL_EVENTS_FIREHOSE_STREAM_NAME;
const SITES_TABLE_NAME = process.env.SITES_TABLE_NAME;
const USER_PREFERENCES_TABLE_NAME = process.env.USER_PREFERENCES_TABLE_NAME; // Add this

// POST /api/events
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const useStripe = process.env.USE_STRIPE === 'true';
  log('Received event:', JSON.stringify(event, null, 2));
  log(`Stripe integration ${useStripe ? 'enabled' : 'disabled'}`);

  // --- Site ID Validation ---
  const siteId = event.queryStringParameters?.site; // Changed from token/header

  if (!siteId) {
    log('Missing site query parameter'); // Updated log message
    return { statusCode: 400, body: JSON.stringify({ message: 'Bad Request: Missing site parameter' }) }; // Updated status code and message
  }

  if (!SITES_TABLE_NAME) {
    console.error("SITES_TABLE_NAME environment variable is not set.");
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error' }) };
  }

  try {
    const getParams = {
      TableName: SITES_TABLE_NAME,
      Key: { site_id: siteId },
    };
    const getSiteCommand = new GetCommand(getParams); // Renamed variable
    const { Item } = await docClient.send(getSiteCommand); // Use renamed variable

    if (!Item) {
      log(`Invalid site_id received: ${siteId}`);
      return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: Invalid site identifier' }) };
    }
    // --- Site Status and Domain Validation ---
    // Expecting is_active to be 1 (true) or 0 (false) from DynamoDB
    if (Item.is_active !== 1) {
      log(`Site ${siteId} is not active.`);
      return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: Site inactive' }) };
    }

    // Optional: Referer validation
    const refererHeader = event.headers?.referer;
    // Expecting domains to be a JSON stringified array from DynamoDB
    const allowedDomainsString = Item.domains as string | undefined;
    if (refererHeader && allowedDomainsString) {
      try {
        const allowedDomains: string[] = JSON.parse(allowedDomainsString);
        if (allowedDomains.length > 0) { // Only validate if domains are configured
          const refererUrl = new URL(refererHeader);
          const refererHostname = refererUrl.hostname;
          if (!allowedDomains.includes(refererHostname)) {
            log(`Referer ${refererHostname} not allowed for site ${siteId}. Allowed: ${allowedDomains.join(', ')}`);
            return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: Invalid referer' }) };
          }
          log(`Referer ${refererHostname} validated for site ${siteId}.`);
        }
      } catch (e) {
        console.error(`Error parsing domains for site ${siteId}: ${allowedDomainsString}`, e);
        // Fail open or closed? Failing closed for security.
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error: Cannot parse site domains' }) };
      }
    }

    log(`Validated site_id: ${siteId}`);

      if (useStripe) {
        log(`Checking payment status and decrementing allowance for site ${siteId} (Stripe enabled)`);
        // --- Fetch User Payment Status ---
        const ownerSub = Item.owner_sub; // Assuming owner_sub is available on the site item
        let is_payment_active = 0; // Default to inactive

        if (!USER_PREFERENCES_TABLE_NAME) {
          console.error("USER_PREFERENCES_TABLE_NAME environment variable is not set. Cannot check payment status.");
          // Fail closed if Stripe is expected but table is missing
          return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error: Missing user preferences table' }) };
        } else if (ownerSub) {
          try {
            const getPrefParams = {
              TableName: USER_PREFERENCES_TABLE_NAME,
              Key: { cognito_sub: ownerSub }, // Correct key based on other files
            };
            const getPrefCommand = new GetCommand(getPrefParams);
            const { Item: userPrefItem } = await docClient.send(getPrefCommand);

            if (userPrefItem && userPrefItem.is_payment_active === 1) {
              is_payment_active = 1;
              log(`User ${ownerSub} has active payment.`);
            } else {
              log(`User ${ownerSub} does not have active payment or preferences not found.`);
            }
          } catch (prefError) {
            console.error(`Error fetching user preferences for ${ownerSub}:`, prefError);
            // Fail closed if Stripe is expected and preference check fails
             return { statusCode: 500, body: JSON.stringify({ message: 'Internal Server Error checking payment status' }) };
          }
        } else {
          console.warn(`Site ${siteId} does not have an owner_sub defined. Cannot check payment status.`);
          // Fail closed if Stripe is expected but owner is missing
           return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: Site owner missing, cannot verify payment' }) };
        }


        // --- Decrement Request Allowance (Conditional) ---
        try {
          const updateParams = {
            TableName: SITES_TABLE_NAME,
            Key: { site_id: siteId },
            ConditionExpression: "attribute_exists(site_id) AND (request_allowance > :zero OR :payment_active = :one)",
            UpdateExpression: "SET request_allowance = request_allowance - :one",
            ExpressionAttributeValues: {
              ":zero": 0,
              ":one": 1,
              ":payment_active": is_payment_active,
            },
            ReturnValues: ReturnValue.NONE, // Use the enum value
          };
          const updateCommand = new UpdateCommand(updateParams);
          await docClient.send(updateCommand);
          log(`Successfully decremented request_allowance for site ${siteId}.`);

        } catch (error: any) {
          if (error.name === 'ConditionalCheckFailedException') {
            log(`Blocking request for site ${siteId}: Allowance exhausted and no active payment.`);
            return {
              statusCode: 402, // Payment Required
              body: JSON.stringify({ message: 'Payment Required: Request allowance exceeded.' }),
            };
          } else {
            // Handle other potential errors during the update
            console.error(`Error decrementing allowance for site ${siteId}:`, error);
            return {
              statusCode: 500,
              body: JSON.stringify({ message: 'Internal Server Error during allowance update' }),
            };
          }
        }
      } else {
         log(`Bypassing payment status check and allowance decrement for site ${siteId} (Stripe disabled)`);
         // No checks needed, proceed with ingestion
      }

    // --- Fetch Site Configuration ---
    // Expecting allowed_fields to be a JSON stringified array from DynamoDB
    const allowedFieldsString = Item.allowed_fields as string | undefined;
    let allowedFields: string[] = [];
    if (allowedFieldsString) {
        try {
            allowedFields = JSON.parse(allowedFieldsString);
            log(`Fetched allowed_fields for site ${siteId}: ${allowedFields.join(', ')}`);
        } catch (e) {
            console.error(`Error parsing allowed_fields for site ${siteId}: ${allowedFieldsString}`, e);
            // Fail open or closed? Failing closed to prevent data leakage.
            return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error: Cannot parse site configuration' }) };
        }
    } else {
        log(`No allowed_fields configured for site ${siteId}, allowing all.`);
        // If no config, allow all fields (or define a default minimal set)
        // For now, allowing all if not specified. Consider changing this default.
        allowedFields = Object.keys(colsAll); // Allow all known fields if not specified
    }

    // --- Event Body Processing ---
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: 'Missing event body' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      console.error("Failed to parse JSON body:", e);
      return {statusCode: 400, body: JSON.stringify({message: 'Invalid JSON format'})};
    }

    const headers = event.headers || {};
    const requestContext = event.requestContext || {};

    const isInitialEvent = !!body.is_initial_event;
    let dataToSend: Record<string, any>;
    let streamName: string | undefined;

    const timestamp = (new Date()).toISOString();

    if (isInitialEvent) {
      // --- Initial Event: Collect all data ---
      streamName = INITIAL_EVENTS_FIREHOSE_STREAM_NAME;

      // Extract geographic information from CloudFront headers
      /*
      TODO: add country(code,name) region(code,name) for emoji lookups?
      "cloudfront-viewer-city": "Lehi",
      "cloudfront-viewer-country": "US",
      "cloudfront-viewer-country-name": "United States",
      "cloudfront-viewer-country-region": "UT",
      "cloudfront-viewer-country-region-name": "Utah",
      "cloudfront-viewer-time-zone": "America/Denver",
       */
      const geoProps = {
        city: headers['cloudfront-viewer-city'],
        region: headers['cloudfront-viewer-country-region-name'] || headers['cloudfront-viewer-country-region'],
        country: headers['cloudfront-viewer-country-name'],
        timezone: headers['cloudfront-viewer-time-zone'],
      };

      // Parse user agent if available
      const userAgent = headers['user-agent'] || requestContext.http?.userAgent || body.userAgent;
      let deviceProps = {};
      if (userAgent) {
        const parser = new UAParser(userAgent);
        const result = parser.getResult();
        deviceProps = {
          device: result.device.type || (result.device.vendor ? `${result.device.vendor} ${result.device.model}` : 'desktop'),
          browser: result.browser.name,
          browser_version: result.browser.version,
          os: result.os.name,
          os_version: result.os.version,
          model: result.device.model,
          manufacturer: result.device.vendor,
        };
      }

      const refererProps = (() => {
        const origin = headers.origin;
        const originDomain = origin ? new URL(origin).hostname : null;
        const referer = body.referer || headers['referer'];
        if (!referer) return { referer: "$direct", referer_domain: "$direct" };
        try {
          const refererUrl = new URL(referer);
          const referer_domain = refererUrl.hostname;
          if (originDomain && referer_domain === originDomain) {
            return { referer: "$direct", referer_domain: "$direct" };
          }
          return { referer, referer_domain };
        } catch (e) {
          console.warn("Invalid referer URL:", referer, e);
          return { referer: "$invalid", referer_domain: "$invalid" };
        }
      })();

      dataToSend = {
        // Client-provided mandatory fields
        event: body.event,
        pathname: body.pathname,
        session_id: body.session_id?.toString(),

        // Server-enriched geo & device data
        ...geoProps,
        ...deviceProps,
        ...refererProps,

        // Screen dimensions: Client only (ensure string)
        screen_height: body.screen_height?.toString(),
        screen_width: body.screen_width?.toString(),

        // UTM parameters: Client only
        utm_source: body.utm_source,
        utm_campaign: body.utm_campaign,
        utm_medium: body.utm_medium,
        utm_content: body.utm_content,
        utm_term: body.utm_term,

        // Timestamps & Properties
        timestamp: timestamp,
        properties: body.properties || {},
        site_id: siteId, // Inject validated site_id
      };

    } else {
      // --- Regular Event: Collect minimal data ---
      streamName = EVENTS_FIREHOSE_STREAM_NAME;

      dataToSend = {
        event: body.event,
        pathname: body.pathname,
        session_id: body.session_id?.toString(),
        properties: body.properties || {},
        timestamp: timestamp,
        site_id: siteId, // Inject validated site_id
      };
    }

    log("Raw dataToSend", dataToSend);

    // --- Field Filtering based on Site Configuration ---
    const essentialFields = new Set(['site_id', 'timestamp', 'event', 'session_id', 'pathname']); // Fields always kept
    const allowedFieldsSet = new Set(allowedFields);
    const filteredDataToSend: Record<string, any> = {};

    for (const key in dataToSend) {
        if (essentialFields.has(key) || allowedFieldsSet.has(key)) {
            filteredDataToSend[key] = dataToSend[key];
        }
    }
    log("Data after site-specific field filtering", filteredDataToSend);
    dataToSend = filteredDataToSend; // Replace original data with filtered data

    // --- Common Cleanup (Null/Undefined Removal) ---
    Object.keys(dataToSend).forEach(key => {
      // // Compliance filter removed - handled by allowed_fields now
      // if (ONLY_COMPLIANT && !isCompliant[key]) {
      //   delete dataToSend[key]; // Remove non-compliant fields directly
      //   return; // Continue to next key
      // }

      // Remove null or undefined values (except for properties object itself)
      if ((dataToSend[key] === undefined || dataToSend[key] === null) && key !== 'properties') {
         // Sending null might cause issues with Parquet conversion depending on schema nullability.
         // Sending an empty string '' is often safer for string columns.
         // We choose to delete the key entirely for cleanliness.
        delete dataToSend[key];
      }
    });

    // Ensure stream name is defined
    if (!streamName) {
      console.error("Stream name could not be determined.");
      return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error: Stream name missing' }) };
    }

    log("Event type", isInitialEvent ? "initial_event" : "regular_event");
    log("Cleaned dataToSend", dataToSend);

    const params = {
      DeliveryStreamName: streamName,
      Record: {
        Data: Buffer.from(JSON.stringify(dataToSend)),
      },
    };

    const putRecordCommand = new PutRecordCommand(params); // Renamed variable
    const response = await firehoseClient.send(putRecordCommand); // Use renamed variable

    log('Successfully put record to Firehose:', response.RecordId); // Correct access

    // Return 202 Accepted as the processing is asynchronous
    return {
      statusCode: 202, // Use 202 Accepted
      body: JSON.stringify({ message: 'Event accepted', recordId: response.RecordId }), // Correct access
    };

  } catch (error: any) {
    console.error('Error putting record to Firehose:', error);
    // Avoid sending detailed error info back to the client in production
    return {
      statusCode: 500,
      body: JSON.stringify({message: 'Internal Server Error'}),
    };
  }
};
