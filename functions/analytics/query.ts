/**
 * Events (for website analytics, like page_view & clicks) are stored as parquet files
 * in S3, cataloged by Glue Iceberg tables. The infra can be seen in /sst.config.ts.
 * This function queries the Iceberg tables using Athena based on the authenticated user's sites
 * and a specified date range.
 */

import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda"; // Use V2 event type with JWT
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
  GetQueryExecutionCommandOutput,
  Row,
  Datum,
} from "@aws-sdk/client-athena";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { subDays, format, parseISO, isValid } from 'date-fns'; // Add date parsing/validation
import {
  ONLY_COMPLIANT,
  initialOnlySchema,
  commonSchema
} from './schema'
import { log } from './utils'

// Initialize AWS Clients
const athenaClient = new AthenaClient({});
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

// Environment Variables
const DATABASE = process.env.ATHENA_DATABASE;
// Use Iceberg table names
const INITIAL_EVENTS_TABLE = process.env.ATHENA_INITIAL_EVENTS_ICEBERG_TABLE;
const EVENTS_TABLE = process.env.ATHENA_EVENTS_ICEBERG_TABLE;
const OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION;
const SITES_TABLE_NAME = process.env.SITES_TABLE_NAME; // For user site lookup

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

    // Remove comments and trailing semicolon if present
    const finalQuery = queryString.replace(/\\s*--.*$/gm, '').trim().replace(/;$/, '');

    if (!DATABASE || !OUTPUT_LOCATION) {
        throw new Error("Missing required environment variables for Athena query.");
    }

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

        // Poll for Query Completion with Exponential Backoff
        let queryState: QueryExecutionState | undefined = undefined;
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

        // Fetch Results
        log(`${queryName} query succeeded. Fetching results...`);
        const resultsCmd = new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId });
        const resultsResponse = await athenaClient.send(resultsCmd);
        const results = parseResults(resultsResponse.ResultSet?.Rows);
        log(`Fetched ${results.length} ${queryName} results.`);
        return results;

    } catch (error: any) {
        console.error(`Error executing ${queryName} Athena query (ID: ${queryExecutionId}):`, error);
        // Best effort stop query (requires StopQueryExecution permission)
        // if (queryExecutionId && error.name !== 'ResourceNotFoundException') {
        //     try {
        //         await athenaClient.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
        //         log(`Attempted to stop query ${queryExecutionId}`);
        //     } catch (stopError) { console.warn(`Could not stop query ${queryExecutionId}:`, stopError); }
        // }
        throw error; // Re-throw
    }
}

// GET /api/query
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
    log('Received event:', JSON.stringify(event, null, 2));

    // --- Authentication & Authorization ---
    const userSub = event.requestContext.authorizer?.jwt.claims.sub;
    if (!userSub) {
        log("Unauthorized: Missing user sub in JWT claims.");
        return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }
    log(`Authenticated user sub: ${userSub}`);

    if (!SITES_TABLE_NAME || !DATABASE || !INITIAL_EVENTS_TABLE || !EVENTS_TABLE || !OUTPUT_LOCATION) {
        console.error("Missing required environment variables.");
        return { statusCode: 500, body: JSON.stringify({ message: "Internal server configuration error." }) };
    }

    // --- Get User's Sites from DynamoDB ---
    let siteIds: string[] = [];
    try {
        const queryCommand = new QueryCommand({
            TableName: SITES_TABLE_NAME,
            IndexName: "ownerSubIndex", // Use the GSI name defined in sst.config.ts
            KeyConditionExpression: "owner_sub = :sub",
            ExpressionAttributeValues: { ":sub": userSub },
            ProjectionExpression: "site_id", // Only fetch the site_id
        });
        const queryResult = await ddbDocClient.send(queryCommand);
        siteIds = queryResult.Items?.map(item => item.site_id) ?? [];

        if (siteIds.length === 0) {
            log(`No sites found for user sub: ${userSub}`);
            // Return empty results, not an error
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initialEvents: [], events: [], commonSchema: [], initialOnlySchema: [] }),
            };
        }
        log(`User ${userSub} has access to sites: ${siteIds.join(', ')}`);

    } catch (error: any) {
        console.error(`Error querying SitesTable for user ${userSub}:`, error);
        return { statusCode: 500, body: JSON.stringify({ message: "Error fetching user sites.", details: error.message }) };
    }

    // --- Get Date Range Parameters ---
    // Default to last 7 days if not provided or invalid
    const defaultEndDate = new Date();
    const defaultStartDate = subDays(defaultEndDate, 6); // 7 days inclusive

    const rawStartDate = event.queryStringParameters?.startDate;
    const rawEndDate = event.queryStringParameters?.endDate;

    let startDate = defaultStartDate;
    let endDate = defaultEndDate;

    if (rawStartDate) {
        const parsed = parseISO(rawStartDate);
        if (isValid(parsed)) {
            startDate = parsed;
        } else {
            log(`Invalid startDate format: ${rawStartDate}. Using default.`);
        }
    }
    if (rawEndDate) {
        const parsed = parseISO(rawEndDate);
        if (isValid(parsed)) {
            endDate = parsed; // Consider setting time to end of day if needed
        } else {
            log(`Invalid endDate format: ${rawEndDate}. Using default.`);
        }
    }

    // Ensure start date is not after end date
    if (startDate > endDate) {
        log(`Start date ${format(startDate, 'yyyy-MM-dd')} is after end date ${format(endDate, 'yyyy-MM-dd')}. Using default range.`);
        startDate = defaultStartDate;
        endDate = defaultEndDate;
    }

    const startDateFormat = format(startDate, 'yyyy-MM-dd');
    const endDateFormat = format(endDate, 'yyyy-MM-dd');
    log(`Querying data from ${startDateFormat} to ${endDateFormat}`);

    // --- Construct Filters ---
    // Use DATE type for dt comparison
    const dateFilterSql = `CAST(dt AS DATE) BETWEEN DATE '${startDateFormat}' AND DATE '${endDateFormat}'`;
    // Create site ID filter (handle potential SQL injection by ensuring siteIds are valid)
    // For simplicity, assuming siteIds are safe internal IDs. Use parameterization if needed.
    const siteIdFilterSql = `site_id IN (${siteIds.map(id => `'${id}'`).join(', ')})`; // Simple IN clause

    try {
        // --- Determine Schemas based on Compliance ---
        const commonSchemaFields = commonSchema.filter(s => ONLY_COMPLIANT ? s.compliant : true);
        const initialOnlySchemaFields = initialOnlySchema.filter(s => ONLY_COMPLIANT ? s.compliant : true);

        // Get column names for SELECT statements
        const commonSelectColNames = commonSchemaFields.map(s => s.name);
        const initialOnlySelectColNames = initialOnlySchemaFields.map(s => s.name);

        // --- Construct SELECT Strings for Athena ---
        const mapColumnToSelect = (colName: string): string => {
            if (colName === 'properties') return `CAST("${colName}" AS JSON) AS "${colName}"`;
            return `"${colName}"`;
        };

        const eventsSelectCols = commonSelectColNames.map(mapColumnToSelect).join(', ');
        const initialSelectCols = [...commonSelectColNames, ...initialOnlySelectColNames].map(mapColumnToSelect).join(', ');

        // --- Construct Queries for Iceberg Tables ---
        const initialEventsQuery = `
SELECT
    ${initialSelectCols}
FROM "${DATABASE}"."${INITIAL_EVENTS_TABLE}"
WHERE ${dateFilterSql} AND ${siteIdFilterSql}
ORDER BY "timestamp" DESC
        `;

        const eventsQuery = `
SELECT
    ${eventsSelectCols}
FROM "${DATABASE}"."${EVENTS_TABLE}"
WHERE ${dateFilterSql} AND ${siteIdFilterSql}
ORDER BY "timestamp" DESC
        `;

        // --- Execute Queries in Parallel ---
        log('Executing queries in parallel...');
        const [initialEventsResults, eventsResults] = await Promise.all([
            executeAthenaQuery(initialEventsQuery, "Initial Events (Iceberg)"),
            executeAthenaQuery(eventsQuery, "Events (Iceberg)")
        ]);

        log(`Finished executing queries. Initial: ${initialEventsResults.length}, Events: ${eventsResults.length}`);

        // Return results separately along with the schemas
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                initialEvents: initialEventsResults,
                events: eventsResults,
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
