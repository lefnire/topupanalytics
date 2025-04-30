import { APIGatewayProxyHandlerV2WithJWTAuthorizer, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
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
// Removed DynamoDB imports
import { subDays, format, parseISO, isValid, isBefore } from 'date-fns'; // Added isBefore
import {
  initialOnlySchema,
  commonSchema
} from './schema';
import { log } from './utils';
import { Resource } from 'sst';
import { db } from '../../shared/db/client'; // Added Drizzle client import
import { sites, events, initialEvents } from '../../shared/db/schema'; // Added Drizzle schema imports
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm'; // Added Drizzle function imports

// Initialize AWS Clients
const athenaClient = new AthenaClient({});
// Removed DynamoDB client initializations


// Helper function for sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to parse Athena results into a more usable format
const parseResults = (rows: Row[] | undefined): Record<string, any>[] => {
    if (!rows || rows.length === 0) return [];
    const headerRow = rows[0].Data;
    if (!headerRow) return [];
    const headers = headerRow.map(d => d.VarCharValue ?? 'unknown');
    const dataRows = rows.slice(1); // Skip header row
    return dataRows.map(row => {
        const record: Record<string, any> = {};
        row.Data?.forEach((datum: Datum, index: number) => {
            // Basic type inference (can be expanded)
            const value = datum.VarCharValue;
            if (value === undefined || value === null) {
                record[headers[index]] = null;
            } else if (!isNaN(Number(value))) {
                record[headers[index]] = Number(value);
            } else if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
                record[headers[index]] = value.toLowerCase() === 'true';
            } else {
                 // Attempt JSON parsing for complex types like maps/arrays if needed
                 try {
                    // Only parse if it looks like JSON (starts with { or [)
                    if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
                        record[headers[index]] = JSON.parse(value);
                    } else {
                        record[headers[index]] = value;
                    }
                 } catch (e) {
                    record[headers[index]] = value; // Fallback to string if JSON parse fails
                 }
            }
        });
        return record;
    });
};


/**
 * Execute an Athena query and return the results with pagination support.
 */
interface AthenaQueryResult {
    results: Record<string, any>[];
}

async function executeAthenaQuery(
    queryString: string,
    queryName: string,
): Promise<AthenaQueryResult> { // Updated return type
    log(`Executing ${queryName} Query:`, queryString);

    const finalQuery = queryString.replace(/\\s*--.*$/gm, '').trim().replace(/;$/, '');

    const s3OutputLocation = `s3://${Resource.AthenaResults.name}/`; // Revert to Logical ID
    console.log(`Using Athena Output Location: ${s3OutputLocation}`);

    const startQueryCmd = new StartQueryExecutionCommand({
        QueryString: finalQuery,
        QueryExecutionContext: { Database: Resource.GlueCatalogDatabase.name }, // Revert to Logical ID
        ResultConfiguration: { OutputLocation: s3OutputLocation }, // Use the constructed path
    });

    let queryExecutionId: string | undefined;
    let queryState: QueryExecutionState | undefined = undefined; // Define here for broader scope

    try {
        const startResponse = await athenaClient.send(startQueryCmd);
        queryExecutionId = startResponse.QueryExecutionId;

        if (!queryExecutionId) {
            throw new Error(`Failed to start ${queryName} query execution.`);
        }
        log(`Started ${queryName} Query Execution ID: ${queryExecutionId}. Waiting for completion...`);

        // Polling logic
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
                // Attempt to stop the query if it failed or was cancelled unexpectedly during polling
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

        // Fetch Results with Pagination Loop
        log(`${queryName} query succeeded. Fetching all results...`);
        const allResults: Record<string, any>[] = [];
        let currentNextToken: string | undefined = undefined;
        const maxResultsPerFetch = 1000; // Athena's max

        do {
            const resultsInput: GetQueryResultsCommandInput = {
                QueryExecutionId: queryExecutionId,
                MaxResults: maxResultsPerFetch, // Use max allowed
                NextToken: currentNextToken // Use token from previous fetch
            };
            log(`Fetching results page... NextToken: ${currentNextToken ?? 'start'}`);
            const resultsResponse: GetQueryResultsCommandOutput = await athenaClient.send(
                new GetQueryResultsCommand(resultsInput)
            );
            const pageResults = parseResults(resultsResponse.ResultSet?.Rows);
            allResults.push(...pageResults);
            currentNextToken = resultsResponse.NextToken;
            log(`Fetched ${pageResults.length} results this page. Total: ${allResults.length}. More pages: ${!!currentNextToken}`);

        } while (currentNextToken); // Continue while there's a next token


        log(`Fetched a total of ${allResults.length} ${queryName} results.`);
        return { results: allResults }; // Return all accumulated results

    } catch (error: any) {
        console.error(`Error executing ${queryName} Athena query (ID: ${queryExecutionId}):`, error);
        // Best effort stop query if it exists and the error isn't about it not being found
        if (queryExecutionId && error.name !== 'ResourceNotFoundException' && queryState !== QueryExecutionState.SUCCEEDED) {
            try {
                await athenaClient.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
                log(`Attempted to stop query ${queryExecutionId} due to error: ${error.message}`);
            } catch (stopError) { console.warn(`Could not stop query ${queryExecutionId} after error:`, stopError); }
        }
        throw error; // Re-throw
    }
}

// GET /api/query
// Use more specific types for event and result
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
        return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }
    log(`Authenticated user sub: ${userSub}`);

    // --- Get User's Owned Sites from Drizzle ---
    let ownedSiteIds: string[] = [];
    try {
        const userSites = await db.select({ siteId: sites.siteId })
                                  .from(sites)
                                  .where(eq(sites.ownerSub, userSub as string)); // Cast userSub to string

        ownedSiteIds = userSites.map(site => site.siteId);

        if (ownedSiteIds.length === 0) {
            log(`No sites found for user sub: ${userSub}`);
            // Return empty results if user owns no sites at all
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initialEvents: [], events: [], commonSchema: [], initialOnlySchema: [], nextToken: null }),
            };
        }
        log(`User ${userSub} owns sites: ${ownedSiteIds.join(', ')}`);

    } catch (error: any) {
        console.error(`Error querying sites table for user ${userSub}:`, error);
        return { statusCode: 500, body: JSON.stringify({ message: "Error fetching user sites.", details: error.message }) };
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
             return {
                statusCode: 403, // Use 403 Forbidden as it's an authorization issue
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "You do not have permission to access the requested site IDs.",
                    initialEvents: [],
                    events: [],
                    commonSchema: [],
                    initialOnlySchema: [],
                    nextToken: null
                }),
             };
        }
    }

    // If after filtering (or if no filter was applied) there are no sites, return empty
    if (finalSiteIds.length === 0) {
         log(`No accessible sites to query for user ${userSub} after applying filters.`);
         return {
             statusCode: 200,
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ initialEvents: [], events: [], commonSchema: [], initialOnlySchema: [], nextToken: null }),
         };
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
        // Set end date to the end of the day for inclusive range
        if (isValid(parsed)) endDate = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999);
        else log(`Invalid endDate format: ${rawEndDate}. Using default.`);
    }

    if (startDate > endDate) {
        log(`Start date ${format(startDate, 'yyyy-MM-dd')} is after end date ${format(endDate, 'yyyy-MM-dd')}. Using default range.`);
        startDate = defaultStartDate;
        endDate = defaultEndDate;
    }

    const startDateFormat = format(startDate, 'yyyy-MM-dd');
    const endDateFormat = format(endDate, 'yyyy-MM-dd'); // Use actual end date for logging
    log(`Querying data from ${startDateFormat} to ${endDateFormat} for sites: ${finalSiteIds.join(', ')}`);

    // --- Hybrid Query Logic ---
    const thirtyDaysAgo = subDays(new Date(), 30);
    const queryRecentData = !isBefore(startDate, thirtyDaysAgo); // Query Aurora if start date is within last 30 days

    log(`Querying ${queryRecentData ? 'Aurora (recent)' : 'Athena (older)'} data based on start date ${startDateFormat}`);

    let queryInitialEvents: Record<string, any>[] = [];
    let queryEvents: Record<string, any>[] = [];

    try {
        // --- Determine Schemas (used for response structure) ---
        const commonSchemaFields = commonSchema.filter(s => s.safe === 'yes' || s.safe === 'maybe');
        const initialOnlySchemaFields = initialOnlySchema.filter(s => s.safe === 'yes' || s.safe === 'maybe');

        if (queryRecentData) {
            // --- Query Aurora using Drizzle ---
            log('Executing Aurora queries...');
            const [auroraInitialEventsResult, auroraEventsResult] = await Promise.all([
                db.select()
                  .from(initialEvents)
                  .where(and(
                      inArray(initialEvents.siteId, finalSiteIds),
                      gte(initialEvents.timestamp, startDate),
                      lte(initialEvents.timestamp, endDate)
                  ))
                  .orderBy(sql`${initialEvents.timestamp} DESC`), // Use sql`` for DESC
                db.select()
                  .from(events)
                  .where(and(
                      inArray(events.siteId, finalSiteIds),
                      gte(events.timestamp, startDate),
                      lte(events.timestamp, endDate)
                  ))
                  .orderBy(sql`${events.timestamp} DESC`) // Use sql`` for DESC
            ]);
            queryInitialEvents = auroraInitialEventsResult;
            queryEvents = auroraEventsResult;
            log(`Finished executing Aurora queries. Initial: ${queryInitialEvents.length}, Events: ${queryEvents.length}`);

        } else {
            // --- Query Athena using existing logic ---
            log('Executing Athena queries...');
            // Construct Filters for Athena
            const dateFilterSql = `dt BETWEEN '${startDateFormat}' AND '${endDateFormat}'`; // Compare partition key as string
            const siteIdFilterSql = `site_id IN (${finalSiteIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')})`; // Basic SQL injection prevention for IDs

            const commonSelectColNames = commonSchemaFields.map(s => s.name);
            const initialOnlySelectColNames = initialOnlySchemaFields.map(s => s.name);

            // Construct SELECT Strings for Athena
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

            const eventsSelectCols = commonSelectColNames.map(mapColumnToSelect).join(', ');
            const initialSelectCols = [...commonSelectColNames, ...initialOnlySelectColNames].map(mapColumnToSelect).join(', ');

            // Construct Queries for Iceberg Tables
            const initialEventsQuery = `
SELECT
    ${initialSelectCols}
FROM "${Resource.GlueCatalogDatabase.name}"."${Resource.GlueCatalogTableinitial_events.name}"
WHERE ${dateFilterSql} AND ${siteIdFilterSql}
ORDER BY "timestamp" DESC
            `;

            const eventsQuery = `
SELECT
    ${eventsSelectCols}
FROM "${Resource.GlueCatalogDatabase.name}"."${Resource.GlueCatalogTableevents.name}"
WHERE ${dateFilterSql} AND ${siteIdFilterSql}
ORDER BY "timestamp" DESC
            `;

            // Execute Queries in Parallel
            const [initialEventsResult, eventsResult] = await Promise.all([
                executeAthenaQuery(initialEventsQuery, "Initial Events (Iceberg)"),
                executeAthenaQuery(eventsQuery, "Events (Iceberg)")
            ]);
            queryInitialEvents = initialEventsResult.results;
            queryEvents = eventsResult.results;
            log(`Finished executing Athena queries. Initial: ${queryInitialEvents.length}, Events: ${queryEvents.length}`);
        }

        // Return results along with the schemas
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                initialEvents: queryInitialEvents,
                events: queryEvents,
                commonSchema: commonSchemaFields.map(({ name, type }) => ({ name, type })),
                initialOnlySchema: initialOnlySchemaFields.map(({ name, type }) => ({ name, type })),
                nextToken: null // Pagination not implemented in this version for simplicity across sources
            }),
        };

    } catch (error: any) {
        console.error(`Error in analytics query handler (querying ${queryRecentData ? 'Aurora' : 'Athena'}):`, error);
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Internal server error during query execution.", details: error.message }),
        };
    }
};
