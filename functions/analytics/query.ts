import { APIGatewayProxyHandlerV2WithJWTAuthorizer, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda"; // Added specific event/result types
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
  GetQueryExecutionCommandOutput,
  Row,
  Datum,
  StopQueryExecutionCommand,
  GetQueryResultsCommandInput,
  GetQueryResultsCommandOutput,
} from "@aws-sdk/client-athena";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { subDays, format, parseISO, isValid } from 'date-fns';
import {
  initialOnlySchema,
  commonSchema
} from './schema';
import { log } from './utils';
import { Resource } from 'sst'
import * as zlib from 'zlib'; // Import for gzip compression

// Initialize AWS Clients
const athenaClient = new AthenaClient({});
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);


// Helper function for sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to parse a single Athena Datum value into its appropriate JS type
const parseDatumValue = (datum: Datum | undefined): any => {
  const value = datum?.VarCharValue;
  if (value === undefined || value === null) {
    return null;
  }
  // Check for boolean first to avoid parsing 'true'/'false' as numbers
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  // Check for number
  const num = Number(value);
  if (!isNaN(num)) {
    return num;
  }
  // Attempt JSON parsing for complex types
  try {
    if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
      return JSON.parse(value);
    }
  } catch (e) {
    // Fallback to string if JSON parse fails or it's not JSON-like
  }
  return value; // Return as string if no other type matches
};

// Helper to parse Athena data rows into an array of arrays based on expected headers
const parseResults = (
  expectedHeaders: string[],
  actualHeaderMap: Map<string, number>,
  dataRows: Row[] | undefined
): any[][] => {
  if (!dataRows || dataRows.length === 0 || expectedHeaders.length === 0 || actualHeaderMap.size === 0) {
    return [];
  }

  return dataRows.map(row => {
    const rowData: any[] = [];
    const actualData = row.Data ?? [];
    for (const expectedHeader of expectedHeaders) {
      const actualIndex = actualHeaderMap.get(expectedHeader);
      // If the expected header exists in the actual results, parse its value
      // Otherwise, push null as a placeholder
      const value = (actualIndex !== undefined && actualIndex < actualData.length)
        ? parseDatumValue(actualData[actualIndex])
        : null;
      rowData.push(value);
    }
    return rowData;
  });
};


/**
 * Defines the structure for the result of executeAthenaQuery, containing only the values array.
 */
interface AthenaQueryResultValuesOnly {
    values: any[][]; // Only values are returned, order matches expectedHeaders
}

/**
 * Execute an Athena query and return the results as an array of value arrays,
 * ordered according to the provided expectedHeaders.
 */
async function executeAthenaQuery(
    queryString: string,
    queryName: string,
    expectedHeaders: string[], // Added parameter
): Promise<AthenaQueryResultValuesOnly> { // Use the new interface type
   log(`Executing ${queryName} Query:`, queryString);

    const finalQuery = queryString.replace(/\\s*--.*$/gm, '').trim().replace(/;$/, '');

    // @ts-ignore - Ignore SST Resource type error
    const s3OutputLocation = `s3://${Resource.AthenaResults.name}/`;
    log(`Using Athena Output Location: ${s3OutputLocation}`);

    const startQueryCmd = new StartQueryExecutionCommand({
        QueryString: finalQuery,
        ResultConfiguration: { OutputLocation: s3OutputLocation },
    });

    let queryExecutionId: string | undefined;
    let queryState: QueryExecutionState | undefined = undefined;

    try {
        const startResponse = await athenaClient.send(startQueryCmd);
        queryExecutionId = startResponse.QueryExecutionId;

        if (!queryExecutionId) {
            throw new Error(`Failed to start ${queryName} query execution.`);
        }
        log(`Started ${queryName} Query Execution ID: ${queryExecutionId}. Waiting for completion...`);

        // Polling logic (remains largely the same)
        let getQueryExecOutput: GetQueryExecutionCommandOutput | undefined;
        const maxAttempts = 30;
        let attempts = 0;
        let backoffTime = 500;
        const maxBackoff = 5000;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                getQueryExecOutput = await athenaClient.send(
                    new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
                );
                queryState = getQueryExecOutput?.QueryExecution?.Status?.State;
            } catch (pollError: any) {
                log(`${queryName} - Attempt ${attempts}: Error polling status: ${pollError.message}. Retrying after ${backoffTime}ms...`);
                if (attempts >= maxAttempts) {
                    throw new Error(`${queryName} query polling failed after multiple retries: ${pollError.message}`);
                }
                await sleep(backoffTime);
                backoffTime = Math.min(backoffTime * 1.5, maxBackoff);
                continue;
            }

            log(`${queryName} - Attempt ${attempts}: Query state: ${queryState}`);

            if (queryState === QueryExecutionState.SUCCEEDED) break;
            if (queryState === QueryExecutionState.FAILED || queryState === QueryExecutionState.CANCELLED) {
                const reason = getQueryExecOutput?.QueryExecution?.Status?.StateChangeReason || 'Unknown reason';
                console.error(`${queryName} query failed or was cancelled:`, reason);
                try {
                    await athenaClient.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
                    log(`Attempted to stop failed/cancelled query ${queryExecutionId}`);
                } catch (stopError) { console.warn(`Could not stop query ${queryExecutionId}:`, stopError); }
                throw new Error(`${queryName} Query ${queryState}: ${reason}`);
            }
            if (queryState === QueryExecutionState.QUEUED || queryState === QueryExecutionState.RUNNING) {
                await sleep(backoffTime);
                backoffTime = Math.min(backoffTime * 1.5, maxBackoff);
            } else {
                 throw new Error(`${queryName} query entered unexpected state: ${queryState}`);
            }
        }

        if (queryState !== QueryExecutionState.SUCCEEDED) {
            throw new Error(`${queryName} query did not succeed after ${attempts} attempts. Final state: ${queryState}`);
        }

        // Fetch Results with Pagination
        log(`${queryName} query succeeded. Fetching results...`);
        const allParsedValues: any[][] = [];
        let actualHeaderMap: Map<string, number> = new Map(); // To store actual headers and their indices
        let currentNextToken: string | undefined = undefined;
        const maxResultsPerFetch = 1000;

        // 1. Fetch the first page to get headers and first batch of data
        const firstPageInput: GetQueryResultsCommandInput = {
            QueryExecutionId: queryExecutionId,
            MaxResults: maxResultsPerFetch,
        };
        log(`Fetching first results page...`);
        const firstPageResponse: GetQueryResultsCommandOutput = await athenaClient.send(
            new GetQueryResultsCommand(firstPageInput)
        );

        const firstPageRows = firstPageResponse.ResultSet?.Rows;
        currentNextToken = firstPageResponse.NextToken;

        if (firstPageRows && firstPageRows.length > 0) {
            // Extract actual headers from the *first* row and create the map
            const headerRow = firstPageRows[0].Data;
            if (headerRow) {
                headerRow.forEach((d, index) => {
                    const headerName = d.VarCharValue ?? `unknown_${index}`;
                    actualHeaderMap.set(headerName, index);
                });
                log(`Extracted actual headers: ${Array.from(actualHeaderMap.keys()).join(', ')}`);

                // Parse data rows from the first page (skip header row) using the new parseResults
                const firstPageDataRows = firstPageRows.slice(1);
                const firstPageParsedValues = parseResults(expectedHeaders, actualHeaderMap, firstPageDataRows);
                allParsedValues.push(...firstPageParsedValues);
                log(`Parsed ${firstPageParsedValues.length} value arrays from first page. Total: ${allParsedValues.length}. More pages: ${!!currentNextToken}`);
            } else {
                log(`Warning: First page response has rows but no header data.`);
            }
        } else {
            log(`No results found for ${queryName} query.`);
            // No results, return empty values array matching the interface
             return { values: [] };
     }


        // 2. Fetch subsequent pages if NextToken exists
        while (currentNextToken) {
            const nextPageInput: GetQueryResultsCommandInput = {
                QueryExecutionId: queryExecutionId,
                MaxResults: maxResultsPerFetch,
                NextToken: currentNextToken
            };
            log(`Fetching next results page... NextToken: ${currentNextToken}`);
            const nextPageResponse: GetQueryResultsCommandOutput = await athenaClient.send(
                new GetQueryResultsCommand(nextPageInput)
            );

            // Subsequent pages do NOT contain headers, parse all rows using the headers map from the first page
            const nextPageRows = nextPageResponse.ResultSet?.Rows;
            // Pass expectedHeaders and the actualHeaderMap
            const nextPageParsedValues = parseResults(expectedHeaders, actualHeaderMap, nextPageRows);
            allParsedValues.push(...nextPageParsedValues);
            currentNextToken = nextPageResponse.NextToken;
            log(`Fetched ${nextPageParsedValues.length} value arrays this page. Total: ${allParsedValues.length}. More pages: ${!!currentNextToken}`);
        }

        log(`Fetched a total of ${allParsedValues.length} ${queryName} value arrays.`);
       // Return only the parsed values, ordered according to expectedHeaders
       return { values: allParsedValues };

   } catch (error: any) {
        console.error(`Error executing ${queryName} Athena query (ID: ${queryExecutionId}):`, error);
        if (queryExecutionId && error.name !== 'ResourceNotFoundException' && queryState !== QueryExecutionState.SUCCEEDED) {
            try {
                await athenaClient.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
                log(`Attempted to stop query ${queryExecutionId} due to error: ${error.message}`);
            } catch (stopError) { console.warn(`Could not stop query ${queryExecutionId} after error:`, stopError); }
        }
        throw error; // Re-throw
    }
}


/**
 * Creates a standard API Gateway response object, applying gzip compression if supported by the client.
 * @param statusCode The HTTP status code.
 * @param data The data payload to be stringified.
 * @param eventHeaders Headers from the incoming API Gateway event, used to check Accept-Encoding.
 * @returns The formatted APIGatewayProxyResultV2 object.
 */
const createApiResponse = (
    statusCode: number,
    data: any,
    eventHeaders: APIGatewayProxyEventV2WithJWTAuthorizer['headers']
): APIGatewayProxyResultV2 => {
  const responseBodyString = JSON.stringify(data);
  // Explicitly type headers according to APIGatewayProxyResultV2['headers']
  const headers: { [header: string]: string | number | boolean } = {
    "Content-Type": "application/json",
    // Add any other default headers here if needed
  };
  let body = responseBodyString;
  let isBase64Encoded = false;

  // Check for gzip support (case-insensitive header check)
  const acceptEncoding = eventHeaders?.['accept-encoding'] || eventHeaders?.['Accept-Encoding'] || '';
  if (/\bgzip\b/.test(acceptEncoding)) { // Use regex for more robust check
    try {
      log('Client accepts gzip, attempting compression...');
      const compressed = zlib.gzipSync(responseBodyString);
      body = compressed.toString('base64');
      headers['Content-Encoding'] = 'gzip'; // Set header
      isBase64Encoded = true;
      log(`Response compressed with gzip. Original size: ${responseBodyString.length}, Compressed size: ${body.length}`);
    } catch (compressionError) {
        console.error("Failed to compress response:", compressionError);
        // Fallback to uncompressed if compression fails
        body = responseBodyString;
        isBase64Encoded = false;
        delete headers['Content-Encoding']; // Ensure header is not set if compression failed
    }
  } else {
    log('Client does not accept gzip or header not present, sending uncompressed.');
  }

  return {
    statusCode,
    headers,
    body,
    isBase64Encoded,
  };
};


// GET /api/query
/**
 * Handles requests to /api/query.
 * Validates user authentication and site ownership.
 * Executes Athena queries based on provided parameters.
 * Returns analytics data (schemas + value arrays), compressed if client supports gzip.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => { // Explicit return type
  const useStripe = process.env.USE_STRIPE === 'true';
  log('Received event:', JSON.stringify(event, null, 2));
  log(`Stripe integration ${useStripe ? 'enabled' : 'disabled'} (Note: Query logic does not currently check plan/payment status)`);

  // --- Authentication & Authorization ---
    const userSub = event.requestContext.authorizer?.jwt.claims.sub;
    if (!userSub) {
        log("Unauthorized: Missing user sub in JWT claims.");
        // Use helper function for response
        return createApiResponse(401, { message: "Unauthorized" }, event.headers);
    }
    log(`Authenticated user sub: ${userSub}`);

    // --- Get User's Owned Sites from DynamoDB ---
    let ownedSiteIds: string[] = [];
    try {
        const queryCommand = new QueryCommand({
            // @ts-ignore - Ignore SST Resource type error
            TableName: Resource.SitesTable.name,
            IndexName: "ownerSubIndex",
            KeyConditionExpression: "owner_sub = :sub",
            ExpressionAttributeValues: { ":sub": userSub },
            ProjectionExpression: "site_id",
        });
        const queryResult = await ddbDocClient.send(queryCommand);
        ownedSiteIds = queryResult.Items?.map(item => item.site_id) ?? [];

        if (ownedSiteIds.length === 0) {
            log(`No sites found for user sub: ${userSub}`);
            // Return empty structure matching the new format
            return createApiResponse(200, {
                initialEventsValues: [],
                eventsValues: [],
                commonSchema: [],
                initialOnlySchema: [],
                nextToken: null
            }, event.headers);
        }
        log(`User ${userSub} owns sites: ${ownedSiteIds.join(', ')}`);

    } catch (error: any) {
        console.error(`Error querying SitesTable for user ${userSub}:`, error);
        // Use helper function for response
        return createApiResponse(500, { message: "Error fetching user sites.", details: error.message }, event.headers);
    }

    // --- Get Query Parameters ---
    const queryParams = event.queryStringParameters ?? {};
    const rawStartDate = queryParams.startDate;
    const rawEndDate = queryParams.endDate;
    const rawSiteIds = queryParams.siteIds; // Comma-separated list

    // --- Parse and Validate Site IDs ---
    let requestedSiteIds: string[] | undefined;
    if (rawSiteIds) {
        requestedSiteIds = rawSiteIds.split(',').map(id => id.trim()).filter(id => id.length > 0);
        log(`Requested site IDs from query params: ${requestedSiteIds.join(', ')}`);
    }

    // Filter owned sites by requested sites, if provided
    let finalSiteIds = ownedSiteIds;
    if (requestedSiteIds) {
        finalSiteIds = ownedSiteIds.filter(ownedId => requestedSiteIds!.includes(ownedId));
        log(`Filtered site IDs (owned & requested): ${finalSiteIds.join(', ')}`);

        if (finalSiteIds.length === 0 && requestedSiteIds.length > 0) { // Only return error if specific sites were requested but none were valid/owned
            log(`User ${userSub} requested specific sites they do not own or requested list is empty after filtering.`);
             // Use helper function for response
             return createApiResponse(403, {
                 message: "You do not have permission to access the requested site IDs.",
                 initialEventsValues: [],
                 eventsValues: [],
                 commonSchema: [],
                 initialOnlySchema: [],
                 nextToken: null
             }, event.headers);
        }
    }

    // If after filtering (or if no filter was applied) there are no sites, return empty
    if (finalSiteIds.length === 0) {
         log(`No accessible sites to query for user ${userSub} after applying filters.`);
         // Use helper function for response
         return createApiResponse(200, {
             initialEventsValues: [],
             eventsValues: [],
             commonSchema: [],
             initialOnlySchema: [],
             nextToken: null
         }, event.headers);
    }


    // --- Parse and Validate Date Range ---
    const defaultEndDate = new Date();
    const defaultStartDate = subDays(defaultEndDate, 6); // 7 days inclusive

    let startDate = defaultStartDate;
    let endDate = defaultEndDate;

    if (rawStartDate) {
        const parsed = parseISO(rawStartDate);
        if (isValid(parsed)) startDate = parsed;
        else log(`Invalid startDate format: ${rawStartDate}. Using default.`);
    }
    if (rawEndDate) {
        const parsed = parseISO(rawEndDate);
        if (isValid(parsed)) endDate = parsed; // Consider setting time to end of day if needed
        else log(`Invalid endDate format: ${rawEndDate}. Using default.`);
    }

    if (startDate > endDate) {
        log(`Start date ${format(startDate, 'yyyy-MM-dd')} is after end date ${format(endDate, 'yyyy-MM-dd')}. Using default range.`);
        startDate = defaultStartDate;
        endDate = defaultEndDate;
    }

    const startDateFormat = format(startDate, 'yyyy-MM-dd');
    const endDateFormat = format(endDate, 'yyyy-MM-dd'); // Use the validated endDate from query params
    log(`Querying data from ${startDateFormat} to ${endDateFormat} for sites: ${finalSiteIds.join(', ')}`);

    // --- Construct Filters ---
    const dateFilterSql = `dt BETWEEN '${startDateFormat}' AND '${endDateFormat}'`; // Compare partition key as string
    // Use the final filtered list of site IDs
    const siteIdFilterSql = `site_id IN (${finalSiteIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')})`; // Basic SQL injection prevention for IDs

    try {
        // --- Determine Schemas and Expected Headers ---
        const commonSchemaFields = commonSchema.filter(s => s.safe === 'yes' || s.safe === 'maybe');
        const initialOnlySchemaFields = initialOnlySchema.filter(s => s.safe === 'yes' || s.safe === 'maybe');

        const commonSelectColNames = commonSchemaFields.map(s => s.name);
        const initialOnlySelectColNames = initialOnlySchemaFields.map(s => s.name);

        // Define the exact order of headers we expect in the response
        const expectedEventsHeaders = commonSelectColNames;
        const expectedInitialHeaders = [...commonSelectColNames, ...initialOnlySelectColNames];

        // --- Construct SELECT Strings for Athena ---
        const mapColumnToSelect = (colName: string): string => {
            const quotedName = `"${colName.replace(/"/g, '""')}"`;
            if (['properties', 'user_properties', 'group_properties'].includes(colName)) {
                 return `TRY_CAST(${quotedName} AS JSON) AS ${quotedName}`;
            }
             if (['value', 'session_duration'].includes(colName)) {
                 return `TRY_CAST(${quotedName} AS DOUBLE) AS ${quotedName}`;
             }
            return quotedName;
        };

        // Select columns based on the expected headers to ensure order matches if possible,
        // although Athena doesn't guarantee column order in SELECT * or similar scenarios.
        // The parsing logic relies on the *actual* headers returned by Athena.
        const eventsSelectCols = expectedEventsHeaders.map(mapColumnToSelect).join(', ');
        const initialSelectCols = expectedInitialHeaders.map(mapColumnToSelect).join(', ');

        // --- Construct Queries for Iceberg Tables ---
        const initialEventsQuery = `
SELECT
  ${initialSelectCols}
FROM "s3tablescatalog/${process.env.S3_TABLE_BUCKET_NAME}"."${process.env.S3_TABLE_NAMESPACE_NAME}"."${process.env.INITIAL_EVENTS_TABLE_NAME}"
WHERE ${dateFilterSql} AND ${siteIdFilterSql}
ORDER BY "timestamp" DESC
        `;

        const eventsQuery = `
SELECT
  ${eventsSelectCols}
FROM "s3tablescatalog/${process.env.S3_TABLE_BUCKET_NAME}"."${process.env.S3_TABLE_NAMESPACE_NAME}"."${process.env.EVENTS_TABLE_NAME}"
WHERE ${dateFilterSql} AND ${siteIdFilterSql}
ORDER BY "timestamp" DESC
        `;

        // --- Execute Queries in Parallel ---
        log('Executing queries in parallel...');
       // Destructure only the 'values' part from the results
       const [{ values: initialEventsValues }, { values: eventsValues }] = await Promise.all([
           // Pass the expected headers to the query function
           // @ts-ignore - Ignore SST Resource type error
           executeAthenaQuery(initialEventsQuery, "Initial Events (Iceberg)", expectedInitialHeaders),
           // @ts-ignore - Ignore SST Resource type error
           executeAthenaQuery(eventsQuery, "Events (Iceberg)", expectedEventsHeaders)
       ]);

        log(`Finished executing queries. Initial values arrays: ${initialEventsValues.length}, Events values arrays: ${eventsValues.length}`);

        // --- Prepare Response ---
        // Use the new structure with only values arrays and schemas
        return createApiResponse(200, {
            initialEventsValues: initialEventsValues, // Use the destructured values
            eventsValues: eventsValues,             // Use the destructured values
            // Keep schema definitions for the frontend to reconstruct objects
            commonSchema: commonSchemaFields.map(({ name, type }) => ({ name, type })),
            initialOnlySchema: initialOnlySchemaFields.map(({ name, type }) => ({ name, type })),
            nextToken: null // Pagination token not implemented in this version
        }, event.headers);

    } catch (error: any) {
        console.error('Error in analytics query handler:', error);
        // Use helper function for response
        return createApiResponse(500, { message: "Internal server error during query execution.", details: error.message }, event.headers);
    }
};
