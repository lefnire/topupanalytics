import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";

// Initialize Firehose client
const firehoseClient = new FirehoseClient({});

// Get Firehose name from environment variable
const firehoseName = process.env.INGEST_HTTP_FIREHOSE_NAME;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Check if Firehose name is configured
  if (!firehoseName) {
    console.error("Configuration error: INGEST_HTTP_FIREHOSE_NAME environment variable not set.");
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal Server Configuration Error' }),
    };
  }

  // 1. Extract site_id from query parameters
  const siteId = event.queryStringParameters?.site;
  if (!siteId) {
    console.log('Missing site query parameter');
    return { statusCode: 400, body: JSON.stringify({ message: 'Bad Request: Missing site parameter' }) };
  }

  // 2. Parse incoming request body
  if (!event.body) {
    console.log('Missing event body');
    return { statusCode: 400, body: JSON.stringify({ message: 'Missing event body' }) };
  }

  let rawEventData;
  try {
    rawEventData = JSON.parse(event.body);
  } catch (e) {
    console.error("Failed to parse JSON body:", e);
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON format' }) };
  }

  // 3. Construct the new payload with original data + site_id
  const payload = {
    ...rawEventData,
    site_id: siteId, // Inject validated site_id
  };

  // 4. Prepare and send data to the new Firehose stream
  const params = {
    DeliveryStreamName: firehoseName,
    Record: {
      Data: Buffer.from(JSON.stringify(payload)),
    },
  };

  try {
    const putRecordCommand = new PutRecordCommand(params);
    await firehoseClient.send(putRecordCommand);
    console.log(`Successfully put record to Firehose ${firehoseName} for site ${siteId}`);

    // 5. Return success response
    return {
      statusCode: 204, // No Content is appropriate here
    };
  } catch (error: any) {
    console.error(`Error putting record to Firehose ${firehoseName} for site ${siteId}:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal Server Error processing event' }),
    };
  }
};
