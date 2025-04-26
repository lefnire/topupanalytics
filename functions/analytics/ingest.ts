import {UAParser} from 'ua-parser-js';
import {APIGatewayProxyHandlerV2} from "aws-lambda"; // Use V2 event type
import {FirehoseClient, PutRecordCommand} from "@aws-sdk/client-firehose";
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
const EVENTS_FIREHOSE_STREAM_NAME = process.env.EVENTS_FIREHOSE_STREAM_NAME;
const INITIAL_EVENTS_FIREHOSE_STREAM_NAME = process.env.INITIAL_EVENTS_FIREHOSE_STREAM_NAME;


// POST /event
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  log('Received event:', JSON.stringify(event, null, 2));

  if (!event.body) {
    return {statusCode: 400, body: JSON.stringify({message: 'Missing event body'})};
  }

  try {
    // Basic validation - ensure it's JSON
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
      };
    }

    log("Raw dataToSend", dataToSend);

    // --- Common Cleanup ---
    Object.keys(dataToSend).forEach(key => {
      // Apply compliance filter
      if (ONLY_COMPLIANT && !isCompliant[key]) {
        delete dataToSend[key]; // Remove non-compliant fields directly
        return; // Continue to next key
      }

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

    const command = new PutRecordCommand(params);
    const response = await firehoseClient.send(command);

    log('Successfully put record to Firehose:', response.RecordId);

    return {
      statusCode: 200,
      body: JSON.stringify({message: 'Event received', recordId: response.RecordId}),
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
