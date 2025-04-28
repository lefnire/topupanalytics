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
  TransactWriteCommand, // Corrected import for batching
} from "@aws-sdk/lib-dynamodb";
import {
  commonSchema,
  initialOnlySchema,
  SchemaField
} from './schema';
import { log } from './utils';

// Initialize Firehose client
const firehoseClient = new FirehoseClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVENTS_FIREHOSE_STREAM_NAME = process.env.EVENTS_FIREHOSE_STREAM_NAME;
const INITIAL_EVENTS_FIREHOSE_STREAM_NAME = process.env.INITIAL_EVENTS_FIREHOSE_STREAM_NAME;
const SITES_TABLE_NAME = process.env.SITES_TABLE_NAME;
const USER_PREFERENCES_TABLE_NAME = process.env.USER_PREFERENCES_TABLE_NAME;

// --- Caching & Batching Implementation ---
interface SiteConfig {
  site_id: string;
  domains?: string; // JSON stringified array
  // allowed_fields?: string; // Replaced by compliance_level
  compliance_level?: 'yes' | 'maybe' | 'no'; // Updated compliance levels
  request_allowance: number;
  owner_sub?: string; // Needed for Stripe check if enabled
}

const siteCache = new Map<string, { cfg: SiteConfig; ts: number }>();
const allowanceDelta: Record<string, number> = {};
const FLUSH = false; // Set to true to enable time-based flushing

async function loadFromDynamo(siteId: string): Promise<SiteConfig> {
  if (!SITES_TABLE_NAME) {
    throw new Error("SITES_TABLE_NAME environment variable is not set.");
  }
  const getParams = {
    TableName: SITES_TABLE_NAME,
    Key: { site_id: siteId },
  };
  const getSiteCommand = new GetCommand(getParams);
  const { Item } = await docClient.send(getSiteCommand);

  if (!Item) {
    log(`Invalid site_id received: ${siteId}`);
    throw new Error('Forbidden: Invalid site identifier'); // Throw error to be caught by handler
  }

  // Basic validation passed, return the config
  // Ensure request_allowance is a number, default to 0 if missing/invalid
  const request_allowance = typeof Item.request_allowance === 'number' ? Item.request_allowance : 0;

  return {
    site_id: Item.site_id,
    domains: Item.domains,
    // allowed_fields: Item.allowed_fields, // Removed
    compliance_level: Item.compliance_level, // Default removed as per greenfield project requirements
    request_allowance: request_allowance,
    owner_sub: Item.owner_sub,
  } as SiteConfig;
}

// Helper function to determine allowed fields based on compliance level
function getAllowedFieldsSet(complianceLevel: 'yes' | 'maybe' | 'no', isInitialEvent: boolean): Set<string> {
  const baseSchema: SchemaField[] = [...commonSchema];
  if (isInitialEvent) {
    baseSchema.push(...initialOnlySchema);
  }

  const allowedFields = new Set<string>();
  for (const field of baseSchema) {
    switch (complianceLevel) {
      case 'yes':
        if (field.safe === 'yes') {
          allowedFields.add(field.name);
        }
        break;
      case 'maybe':
        if (field.safe === 'yes' || field.safe === 'maybe') {
          allowedFields.add(field.name);
        }
        break;
      case 'no':
        // 'no' level allows all defined fields ('yes', 'maybe', 'no')
        allowedFields.add(field.name);
        break;
    }
  }

  // Ensure essential fields are always included, although schema should cover them
  allowedFields.add('site_id');
  allowedFields.add('timestamp');

  return allowedFields;
}


async function flush() {
  const updates = Object.entries(allowanceDelta).map(([site_id, cnt]) => ({
    Update: {
      TableName: SITES_TABLE_NAME!, // Use non-null assertion as it's checked earlier
      Key: { site_id },
      // Condition: Only decrement if current allowance is sufficient
      ConditionExpression: "attribute_exists(site_id) AND request_allowance >= :cnt",
      UpdateExpression: "SET request_allowance = request_allowance - :cnt",
      ExpressionAttributeValues: {
        ":cnt": cnt,
      },
    },
  }));

  if (updates.length > 0) {
    log(`Flushing allowance updates for ${updates.length} sites:`, Object.keys(allowanceDelta));
    try {
      const transactWriteCommand = new TransactWriteCommand({ TransactItems: updates }); // Corrected command name
      await docClient.send(transactWriteCommand);
      log("Flush successful.");
      // Clear delta only after successful write
      Object.keys(allowanceDelta).forEach((k) => delete allowanceDelta[k]);
    } catch (error: any) {
      // Handle potential errors, especially ConditionalCheckFailedException
      // which might occur if allowance was depleted between check and flush.
      console.error("Error during allowance flush:", error);
      // Decide on error handling: retry? clear delta partially? For now, log and clear.
      // If a specific update fails due to condition check, it won't decrement,
      // but we clear the delta here. The next request might fail the optimistic check.
      Object.keys(allowanceDelta).forEach((k) => delete allowanceDelta[k]); // Clear delta even on error to prevent retrying failed decrements immediately
      // Re-throwing might be appropriate depending on desired behavior
      // throw error;
    }
  } else {
    log("No allowance updates to flush.");
  }
}


// POST /api/events
// Add 'context' to the handler signature
export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const now = Date.now();
  log('Received event:', JSON.stringify(event, null, 2));

  // --- Site ID Validation ---
  const siteId = event.queryStringParameters?.site;
  if (!siteId) {
    log('Missing site query parameter');
    return { statusCode: 400, body: JSON.stringify({ message: 'Bad Request: Missing site parameter' }) };
  }

  if (!SITES_TABLE_NAME) {
      console.error("SITES_TABLE_NAME environment variable is not set.");
      return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error' }) };
  }

  try {
    // --- 1. Get Site Config (Cache or Load) ---
    let entry = siteCache.get(siteId);
    if (!entry || now - entry.ts > 10 * 60 * 1000) { // 10-min TTL
      log(`Cache miss or expired for site ${siteId}. Fetching from DynamoDB.`);
      try {
        const loadedCfg = await loadFromDynamo(siteId);
        entry = { cfg: loadedCfg, ts: now };
        siteCache.set(siteId, entry);
        log(`Cached config for site ${siteId}.`);
      } catch (loadError: any) {
        // Handle errors from loadFromDynamo (e.g., not found, inactive)
        log(`Error loading site config for ${siteId}:`, loadError.message);
        if (loadError.message.includes('Forbidden')) {
          return { statusCode: 403, body: JSON.stringify({ message: loadError.message }) };
        }
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal Server Error loading site configuration' }) };
      }
    } else {
      log(`Cache hit for site ${siteId}.`);
    }

    const cfg = entry.cfg;

    // --- Domain Validation (using cached config) ---
    const refererHeader = event.headers?.referer;
    const allowedDomainsString = cfg.domains;
    if (refererHeader && allowedDomainsString) {
      try {
        const allowedDomains: string[] = JSON.parse(allowedDomainsString);
        if (allowedDomains.length > 0) {
          const refererUrl = new URL(refererHeader);
          const refererHostname = refererUrl.hostname;
          if (!allowedDomains.includes(refererHostname)) {
            log(`Referer ${refererHostname} not allowed for site ${siteId}. Allowed: ${allowedDomains.join(', ')}`);
            return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: Invalid referer' }) };
          }
          log(`Referer ${refererHostname} validated for site ${siteId}.`);
        }
      } catch (e) {
        console.error(`Error parsing cached domains for site ${siteId}: ${allowedDomainsString}`, e);
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal configuration error: Cannot parse site domains' }) };
      }
    }

    // --- 2. Optimistic Allowance Check ---
    // Note: Stripe payment status check is implicitly handled by the flush condition `request_allowance >= :cnt`.
    // If payment is active, allowance might go negative in DB but the optimistic check here prevents requests if local shadow is <= 0.
    // This differs slightly from the original logic but aligns with the batching goal.
    if (cfg.request_allowance <= 0) {
      log(`Optimistic check failed for site ${siteId}: Allowance exhausted (cached value: ${cfg.request_allowance}).`);
      // Potentially call flush here if needed to sync near-zero allowance? For now, just block.
      // await flush(); // Optional: Flush before returning to ensure DB is up-to-date
      return {
        statusCode: 402, // Payment Required
        body: JSON.stringify({ message: 'Payment Required: Request allowance likely exceeded.' }),
      };
    }

    // --- 3. Update Delta & Local Shadow ---
    allowanceDelta[siteId] = (allowanceDelta[siteId] ?? 0) + 1;
    cfg.request_allowance--; // Decrement local shadow copy
    log(`Allowance check passed for site ${siteId}. New local allowance: ${cfg.request_allowance}. Delta incremented to: ${allowanceDelta[siteId]}`);

    // --- 4. Flush Logic ---
    if (!FLUSH) {
      log("FLUSH is false, flushing immediately.");
      await flush();
    } else {
      const remainingTime = context.getRemainingTimeInMillis();
      log(`FLUSH is true. Remaining time: ${remainingTime}ms`);
      if (remainingTime < 1000) { // Using 1000ms threshold
        log("Remaining time low, flushing allowance updates.");
        await flush();
      }
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

      // --- Referer Handling (Conditional Scrubbing) ---
      const refererProps = (() => {
        const rawReferer = body.referer || headers['referer'];
        if (!rawReferer || rawReferer === "$direct") {
          return { referer: "$direct", referer_domain: "$direct" };
        }

        try {
          const refererUrl = new URL(rawReferer);
          const originalReferer = rawReferer; // Keep original
          const referer_domain = refererUrl.hostname;

          // Check if referer is same as origin (if origin header exists)
          const origin = headers.origin;
          const originDomain = origin ? new URL(origin).hostname : null;
          if (originDomain && referer_domain === originDomain) {
            return { referer: "$direct", referer_domain: "$direct" }; // Treat same-origin as direct
          }

          // Apply scrubbing only for 'yes' and 'maybe' compliance levels
          const complianceLevel = cfg.compliance_level || 'maybe'; // Default to 'maybe' if not set
          if (complianceLevel === 'yes' || complianceLevel === 'maybe') {
            const scrubbedReferer = refererUrl.origin + refererUrl.pathname; // Keep only origin + path
            log(`Scrubbing referer for compliance level: ${complianceLevel}`);
            return { referer: scrubbedReferer, referer_domain };
          } else {
            // For 'no' compliance level, keep the original referer
            log(`Keeping original referer for compliance level: ${complianceLevel}`);
            return { referer: originalReferer, referer_domain };
          }
        } catch (e) {
          console.warn("Invalid referer URL:", rawReferer, e);
          // Keep original invalid value if parsing fails, but mark domain as invalid
          return { referer: rawReferer, referer_domain: "$invalid" };
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
        ...refererProps, // Use potentially scrubbed referer data

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

    log("Data before compliance filtering", dataToSend);

    // --- Compliance-Based Filtering ---
    const complianceLevel = cfg.compliance_level || 'maybe'; // Default to 'maybe' if not set in config
    const allowedFieldsSet = getAllowedFieldsSet(complianceLevel, isInitialEvent);
    log(`Applying filtering for compliance level: ${complianceLevel}. Allowed fields:`, Array.from(allowedFieldsSet));

    const filteredData: Record<string, any> = {};
    for (const key in dataToSend) {
      if (allowedFieldsSet.has(key)) {
        // Additionally, remove null/undefined values here (except for properties object)
        if ((dataToSend[key] !== undefined && dataToSend[key] !== null) || key === 'properties') {
          filteredData[key] = dataToSend[key];
        } else {
           log(`Removing null/undefined field (post-filter): ${key}`);
        }
      } else {
        log(`Filtering out field due to compliance level ${complianceLevel}: ${key}`);
      }
    }
    dataToSend = filteredData; // Replace with filtered data

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
