import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena";

const athena = new AthenaClient({});

// Environment variables passed from sst.config.ts
const ATHENA_DATABASE = process.env.ATHENA_DATABASE!;
const ATHENA_INITIAL_EVENTS_ICEBERG_TABLE = process.env.ATHENA_INITIAL_EVENTS_ICEBERG_TABLE!;
const ATHENA_EVENTS_ICEBERG_TABLE = process.env.ATHENA_EVENTS_ICEBERG_TABLE!;
const ATHENA_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION!; // Location for query metadata/results

/**
 * Starts an Athena query execution but does not wait for completion.
 * @param query The SQL query string to execute.
 * @param database The Athena database name.
 * @param outputLocation The S3 location for query results metadata.
 * @returns The Query Execution ID.
 */
async function startAthenaQuery(query: string, database: string, outputLocation: string): Promise<string | undefined> {
    console.log(`Starting Athena query: ${query}`);
    try {
        const startCmd = new StartQueryExecutionCommand({
            QueryString: query,
            QueryExecutionContext: { Database: database },
            ResultConfiguration: { OutputLocation: outputLocation },
        });
        const startRes = await athena.send(startCmd);
        const queryExecutionId = startRes.QueryExecutionId;

        if (!queryExecutionId) {
            console.error("Failed to start Athena query execution (no QueryExecutionId returned).");
            return undefined;
        }
        console.log(`Athena query started with ExecutionId: ${queryExecutionId}`);
        return queryExecutionId;
    } catch (error) {
        console.error(`Error starting Athena query: ${query}`, error);
        return undefined; // Indicate failure
    }
}

/**
 * Main handler function triggered by the SST Cron job.
 * Initiates Athena OPTIMIZE queries for Iceberg tables.
 */
export async function handler(event: any): Promise<{ status: string; message?: string; queryIds?: (string | undefined)[] }> {
    console.log("Starting Iceberg table OPTIMIZE job...", JSON.stringify(event));

    if (!ATHENA_DATABASE || !ATHENA_INITIAL_EVENTS_ICEBERG_TABLE || !ATHENA_EVENTS_ICEBERG_TABLE || !ATHENA_OUTPUT_LOCATION) {
        const errorMessage = "Missing required environment variables (Database, Iceberg Table Names, Output Location).";
        console.error(errorMessage);
        return { status: "Failed", message: errorMessage };
    }

    const queries = [
        `OPTIMIZE "${ATHENA_DATABASE}"."${ATHENA_INITIAL_EVENTS_ICEBERG_TABLE}"
         WHERE dt < current_date
           AND dt >= date_add('day', -7, current_date)
         REWRITE DATA USING BIN_PACK`,
        `OPTIMIZE "${ATHENA_DATABASE}"."${ATHENA_EVENTS_ICEBERG_TABLE}"
         WHERE dt < current_date
           AND dt >= date_add('day', -7, current_date)
         REWRITE DATA USING BIN_PACK`
    ];

    const queryExecutionIds: (string | undefined)[] = [];
    let allStartedSuccessfully = true;

    for (const query of queries) {
        const queryId = await startAthenaQuery(query, ATHENA_DATABASE, ATHENA_OUTPUT_LOCATION);
        queryExecutionIds.push(queryId);
        if (!queryId) {
            allStartedSuccessfully = false;
            // Continue starting others even if one fails
        }
    }

    const finalStatus = allStartedSuccessfully ? "Started" : "Started with errors";
    const message = allStartedSuccessfully
        ? `Successfully started OPTIMIZE queries for tables: ${ATHENA_INITIAL_EVENTS_ICEBERG_TABLE}, ${ATHENA_EVENTS_ICEBERG_TABLE}.`
        : `Attempted to start OPTIMIZE queries. Check logs for errors. Query IDs: ${queryExecutionIds.join(', ')}`;

    console.log(`Iceberg OPTIMIZE job finished initiating queries. Status: ${finalStatus}`);
    return { status: finalStatus, message: message, queryIds: queryExecutionIds };
}
