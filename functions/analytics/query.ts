/**
 * Events (for website analytics, like page_view & clicks) are stored as parquet files
 * in S3, cataloged by a Glue Table. The infra can be seen in /sst.config.ts. This is for
 * an app that's a data analytics platform, so scalability and cost are the most
 * important factors (since there's eventually gonna be terrabytes of data) and I was
 * told this setup is the cheapest, most scalable solution.
 *
 * Now, the data is stored as:
 * * `/events/dt=YYYY-MM-DD`
 * * `/initial_events/dt=YYYY-MM-DD`
 *
 * `initial_events` are fully-hydrated event data, that's sent from the client on the very
 * page_view of the session. This includes session_id, pathname, geo, device, referer, utm, etc
 * - see ./ingest.ts. Subsequent events of that session are stored in `events`, and only include the data
 * needed for that particular event: session_id, pathname, event, timestamp, etc.
 *
 * This file here fetches the `initial_events` and `events` for a given time range, using
 * Athena to query the Glue Tables. The results are returned separately.
 */

import {APIGatewayProxyHandlerV2} from "aws-lambda"; // Use V2 event type
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand, // Re-needed for polling
  GetQueryResultsCommand,
  QueryExecutionState,      // Re-needed for polling
  GetQueryExecutionCommandOutput, // Re-needed for polling
  Row,
  Datum,
  // waitUntilQueryExecutionSucceeded // Removed waiter import
} from "@aws-sdk/client-athena";
import { subDays, format } from 'date-fns'; // Or use Day.js or Luxon
import {
  ONLY_COMPLIANT,
  initialOnlySchema, // Keep this import to derive initial-only fields
  eventsColsCompliant,
  eventsColsAll,
  initialEventsSchema, // Keep this import to get types
  initialColsAll,
  commonSchema // Import commonSchema definition as well
} from './schema'
import {log} from './utils'

// Initialize Athena client
const athenaClient = new AthenaClient({});
const DATABASE = process.env.ATHENA_DATABASE;
const INITIAL_EVENTS_TABLE = process.env.ATHENA_INITIAL_EVENTS_TABLE;
const EVENTS_TABLE = process.env.ATHENA_EVENTS_TABLE;
const OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION;

// Helper function for sleep (Re-needed for polling)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
//  generatePartitionFilter (REMOVED)
// -----------------------------------------------------------------------------
// This function is no longer needed as we use a simple date range filter
// on the 'dt' partition.

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
            record[headers[index]] = datum.VarCharValue; // Simple parsing, might need type conversion
        });
        return record;
    });
};

/**
 * Execute an Athena query and return the results
 */
async function executeAthenaQuery(
    queryString: string,
    queryName: string
): Promise<Record<string, any>[]> {
    log(`Executing ${queryName} Query:`, queryString);

    // Remove comments and trailing semicolon if present, as Athena expects only one statement
    const finalQuery = queryString.replace(/\\s*--.*$/gm, '').trim().replace(/;$/, '');

    const startQueryCmd = new StartQueryExecutionCommand({
        QueryString: finalQuery,
        QueryExecutionContext: { Database: DATABASE },
        ResultConfiguration: { OutputLocation: OUTPUT_LOCATION },
    });

    let queryExecutionId: string | undefined;

    try {
        const startResponse = await athenaClient.send(startQueryCmd);
        queryExecutionId = startResponse.QueryExecutionId;

        if (!queryExecutionId) {
            throw new Error(`Failed to start ${queryName} query execution.`);
        }
        log(`Started ${queryName} Query Execution ID: ${queryExecutionId}. Waiting for completion...`);

        // --- Poll for Query Completion with Exponential Backoff ---
        let queryState: QueryExecutionState | undefined = undefined;
        let getQueryExecOutput: GetQueryExecutionCommandOutput | undefined;
        const maxAttempts = 30; // Max attempts (e.g., 30 attempts with ~5s max wait = ~2.5 mins max)
        let attempts = 0;
        let backoffTime = 500; // Start with 0.5 seconds
        const maxBackoff = 5000; // Max 5 seconds between polls

        while (attempts < maxAttempts) {
            attempts++;
            try {
                getQueryExecOutput = await athenaClient.send(
                    new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
                );
                queryState = getQueryExecOutput?.QueryExecution?.Status?.State;
            } catch (pollError: any) {
                // Handle potential errors during polling (e.g., ThrottlingException)
                log(`${queryName} - Attempt ${attempts}: Error polling status: ${pollError.message}. Retrying after ${backoffTime}ms...`);
                if (attempts >= maxAttempts) {
                    throw new Error(`${queryName} query polling failed after multiple retries: ${pollError.message}`);
                }
                await sleep(backoffTime);
                backoffTime = Math.min(backoffTime * 1.5, maxBackoff);
                continue; // Skip to next attempt
            }

            log(`${queryName} - Attempt ${attempts}: Query state: ${queryState}`);

            if (queryState === QueryExecutionState.SUCCEEDED) {
                break; // Exit loop on success
            } else if (queryState === QueryExecutionState.FAILED || queryState === QueryExecutionState.CANCELLED) {
                const reason = getQueryExecOutput?.QueryExecution?.Status?.StateChangeReason || 'Unknown reason';
                console.error(`${queryName} query failed or was cancelled:`, reason);
                throw new Error(`${queryName} Query ${queryState}: ${reason}`);
            } else if (queryState === QueryExecutionState.QUEUED || queryState === QueryExecutionState.RUNNING) {
                // Continue polling
                await sleep(backoffTime);
                backoffTime = Math.min(backoffTime * 1.5, maxBackoff); // Increase backoff for next poll
            } else {
                 // Handle unexpected states if necessary
                 throw new Error(`${queryName} query entered unexpected state: ${queryState}`);
            }
        }

        if (queryState !== QueryExecutionState.SUCCEEDED) {
            // If loop finishes without success (e.g., maxAttempts reached)
            throw new Error(`${queryName} query did not succeed after ${attempts} attempts. Final state: ${queryState}`);
        }


        // --- Fetch Results ---
        log(`${queryName} query succeeded. Fetching results...`);
        const resultsCmd = new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId });
        const resultsResponse = await athenaClient.send(resultsCmd);

        const results = parseResults(resultsResponse.ResultSet?.Rows);
        log(`Fetched ${results.length} ${queryName} results.`);

        return results;
    } catch (error: any) {
        console.error(`Error executing ${queryName} Athena query (ID: ${queryExecutionId}):`, error);
        // If the query started but failed/cancelled, try to stop it (best effort)
        if (queryExecutionId && error.name !== 'ResourceNotFoundException') { // Avoid stopping if ID never existed
            try {
                // Stop potentially running query on error (implement if needed, requires StopQueryExecution permission)
                // await athenaClient.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
                // log(`Attempted to stop query ${queryExecutionId}`);
            } catch (stopError) {
                console.warn(`Could not stop query ${queryExecutionId}:`, stopError);
            }
        }
        throw error; // Re-throw to be handled by the caller
    }
}

// GET /query
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
    log('Received event:', JSON.stringify(event, null, 2));

    // --- Get Date Range Parameter ---
    const rangeParam = event.queryStringParameters?.range ?? '7d'; // Default to 7 days
    let rangeDays = 7;
    if (rangeParam.endsWith('d')) {
        const days = parseInt(rangeParam.slice(0, -1), 10);
        if (!isNaN(days) && days > 0) {
            rangeDays = days;
        } else {
             console.warn(`Invalid range format: ${rangeParam}. Defaulting to 7 days.`);
             // rangeDays remains 7
        }
    } else {
        console.warn(`Invalid range format: ${rangeParam}. Defaulting to 7 days.`);
        // rangeDays remains 7
    }
    log(`Processing range: ${rangeDays} days`);

    // --- Calculate Date Range ---
    const endDate = new Date();
    const startDate = subDays(endDate, rangeDays -1); // Inclusive range (e.g., 7d = today + 6 previous days)
    const startDateFormat = format(startDate, 'yyyy-MM-dd');
    const endDateFormat = format(endDate, 'yyyy-MM-dd');
    // Cast dt to DATE explicitly to ensure correct comparison with DATE literals
    const dateFilterSql = `CAST(dt AS DATE) BETWEEN DATE '${startDateFormat}' AND DATE '${endDateFormat}'`;

    try {
        // --- Determine Schemas based on Compliance ---
        const commonSchemaFields = commonSchema.filter(s => ONLY_COMPLIANT ? s.compliant : true);
        const initialOnlySchemaFields = initialOnlySchema.filter(s => ONLY_COMPLIANT ? s.compliant : true);

        // Get column names for SELECT statements
        const commonSelectColNames = commonSchemaFields.map(s => s.name);
        const initialOnlySelectColNames = initialOnlySchemaFields.map(s => s.name);

        // --- Construct SELECT Strings for Athena ---
        // Athena needs quoted names, and properties needs casting
        const mapColumnToSelect = (colName: string): string => {
            if (colName === 'properties') {
                // Cast map to JSON string directly in Athena
                return `CAST("${colName}" AS JSON) AS "${colName}"`;
            } else {
                // Just quote other column names
                return `"${colName}"`;
            }
        };

        const eventsSelectCols = commonSelectColNames
            .map(mapColumnToSelect) // Use the mapping function
            .join(', ');

        const initialSelectCols = [...commonSelectColNames, ...initialOnlySelectColNames]
            .map(mapColumnToSelect) // Use the mapping function
            .join(', ');


        // --- Construct Separate Queries ---
        // No need to check for empty columns as schema guarantees compliant columns exist
        const initialEventsQuery = `
SELECT
    ${initialSelectCols} 
FROM "${DATABASE}"."${INITIAL_EVENTS_TABLE}"
WHERE ${dateFilterSql}
ORDER BY "timestamp" DESC
        `;

        const eventsQuery = `
SELECT
    ${eventsSelectCols}
FROM "${DATABASE}"."${EVENTS_TABLE}"
WHERE ${dateFilterSql}
ORDER BY "timestamp" DESC
        `;


        // --- Execute Queries in Parallel ---
        log('Executing queries in parallel...');
        // No need for conditional execution as column lists are guaranteed non-empty
        const [initialEventsResults, eventsResults] = await Promise.all([
            executeAthenaQuery(initialEventsQuery, "Initial Events"),
            executeAthenaQuery(eventsQuery, "Events")
        ]);

        log(`Finished executing queries. Initial: ${initialEventsResults.length}, Events: ${eventsResults.length}`);

        // Return results separately along with the schemas
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                initialEvents: initialEventsResults,
                events: eventsResults,
                // Send the determined schema fields (name and type)
                commonSchema: commonSchemaFields.map(({ name, type }) => ({ name, type })),
                initialOnlySchema: initialOnlySchemaFields.map(({ name, type }) => ({ name, type }))
            }),
        };

    } catch (error: any) {
        console.error('Error in analytics query handler:', error);
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Internal server error", details: error.message }),
        };
    }
};
