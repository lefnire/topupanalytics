import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, QueryExecutionState } from "@aws-sdk/client-athena";
import { GlueClient, DeleteTableCommand, GetTableCommand } from "@aws-sdk/client-glue"; // Added DeleteTableCommand
import { setTimeout } from "timers/promises";
import { initialGlueColumns, eventsGlueColumns } from './analytics/schema'; // Import schemas directly

// Environment variables expected from SST link bindings or Invocation payload
const GLUE_DATABASE_NAME = process.env.GLUE_DATABASE_NAME;
const EVENTS_BUCKET_NAME = process.env.EVENTS_BUCKET_NAME;
const QUERY_RESULTS_BUCKET_NAME = process.env.QUERY_RESULTS_BUCKET_NAME;

const athena = new AthenaClient({});
const glue = new GlueClient({});
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 5000;

interface IcebergInitEvent {
  INITIAL_EVENTS_ICEBERG_TABLE_NAME: string;
  EVENTS_ICEBERG_TABLE_NAME: string;
  ATHENA_WORKGROUP: string; // Typically 'primary'
}

// Helper function to wait for Athena query completion
async function waitForQueryCompletion(queryExecutionId: string): Promise<void> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    try {
      const command = new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId });
      const response = await athena.send(command);
      const state = response.QueryExecution?.Status?.State;

      console.log(`Polling query ${queryExecutionId}, attempt ${i + 1}/${MAX_POLL_ATTEMPTS}, State: ${state}`);

      if (state === QueryExecutionState.SUCCEEDED) {
        console.log(`Query ${queryExecutionId} succeeded.`);
        return;
      } else if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
        const reason = response.QueryExecution?.Status?.StateChangeReason;
        throw new Error(`Query ${queryExecutionId} failed or was cancelled. State: ${state}, Reason: ${reason}`);
      }
    } catch (error) {
      console.error(`Error polling query ${queryExecutionId}:`, error);
      // Don't rethrow immediately, allow polling to continue unless it's the last attempt
      if (i === MAX_POLL_ATTEMPTS - 1) {
          throw error; // Rethrow final error
      }
    }
    await setTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(`Query ${queryExecutionId} did not complete within the maximum polling time.`);
}

// Helper function to execute a query and wait for completion
async function executeAthenaQuery(queryString: string, databaseName: string, workgroup: string, outputLocation: string): Promise<string> {
    console.log(`Executing Athena query in workgroup ${workgroup}, database ${databaseName}:\n${queryString}`);
    const startCommand = new StartQueryExecutionCommand({
        QueryString: queryString,
        WorkGroup: workgroup,
        ResultConfiguration: { OutputLocation: outputLocation },
        QueryExecutionContext: { Database: databaseName },
    });

    try {
        const startResponse = await athena.send(startCommand);
        const queryExecutionId = startResponse.QueryExecutionId;

        if (!queryExecutionId) {
            throw new Error("Failed to get QueryExecutionId from StartQueryExecutionCommand.");
        }
        console.log(`Started query execution with ID: ${queryExecutionId}`);
        await waitForQueryCompletion(queryExecutionId);
        return queryExecutionId; // Return ID on success

    } catch (error) {
        console.error("Athena query execution failed:", error);
        throw error instanceof Error ? error : new Error(`Unknown Athena execution error occurred: ${error}`);
    }
}

// Helper to check if a table exists and optionally delete it
async function ensureTableDoesNotExist(databaseName: string, tableName: string): Promise<void> {
    try {
        await glue.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
        console.log(`Table ${databaseName}.${tableName} exists. Deleting for idempotency...`);
        await glue.send(new DeleteTableCommand({ DatabaseName: databaseName, Name: tableName }));
        console.log(`Table ${databaseName}.${tableName} deleted.`);
        // Add a small delay to allow Glue metastore to update
        await setTimeout(5000);
    } catch (error: any) {
        if (error.name === 'EntityNotFoundException') {
            console.log(`Table ${databaseName}.${tableName} does not exist. Proceeding with creation.`);
        } else {
            console.error(`Error checking or deleting table ${databaseName}.${tableName}:`, error);
            throw error; // Rethrow unexpected errors
        }
    }
}

// Helper to format columns for CREATE TABLE statement
function formatColumnsForDDL(columns: { name: string; type: string }[]): string {
    // Ensure proper quoting and type mapping if necessary (basic types assumed here)
    // Athena/Glue types are generally compatible with Parquet/JSON types used
    return columns.map(col => `\`${col.name}\` ${col.type}`).join(',\n  ');
}

export async function handler(event: IcebergInitEvent): Promise<any> {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // Validate environment variables
  if (!GLUE_DATABASE_NAME || !EVENTS_BUCKET_NAME || !QUERY_RESULTS_BUCKET_NAME) {
    throw new Error("Missing required environment variables GLUE_DATABASE_NAME, EVENTS_BUCKET_NAME, or QUERY_RESULTS_BUCKET_NAME.");
  }
  // Validate event payload
  if (!event.INITIAL_EVENTS_ICEBERG_TABLE_NAME || !event.EVENTS_ICEBERG_TABLE_NAME || !event.ATHENA_WORKGROUP) {
      throw new Error("Missing required properties in the event payload: INITIAL_EVENTS_ICEBERG_TABLE_NAME, EVENTS_ICEBERG_TABLE_NAME, ATHENA_WORKGROUP.");
  }

  const {
    INITIAL_EVENTS_ICEBERG_TABLE_NAME,
    EVENTS_ICEBERG_TABLE_NAME,
    ATHENA_WORKGROUP,
  } = event;

  const queryOutputLocation = `s3://${QUERY_RESULTS_BUCKET_NAME}/iceberg-init-ddl/`;
  const initialEventsTableLocation = `s3://${EVENTS_BUCKET_NAME}/managed_iceberg/initial_events/`; // Match sst.config location
  const eventsTableLocation = `s3://${EVENTS_BUCKET_NAME}/managed_iceberg/events/`; // Match sst.config location

  try {
      // --- Create Initial Events Iceberg Table ---
      console.log(`--- Initializing Initial Events Iceberg Table: ${INITIAL_EVENTS_ICEBERG_TABLE_NAME} ---`);
      await ensureTableDoesNotExist(GLUE_DATABASE_NAME, INITIAL_EVENTS_ICEBERG_TABLE_NAME); // Ensure idempotency

      const initialEventsColumnsDDL = formatColumnsForDDL(initialGlueColumns);
      const initialEventsQuery = `
        CREATE TABLE ${INITIAL_EVENTS_ICEBERG_TABLE_NAME} (
          ${initialEventsColumnsDDL}
        )
        PARTITIONED BY (site_id, dt) -- Define partitioning columns here
        LOCATION '${initialEventsTableLocation}'
        TBLPROPERTIES (
          'table_type' = 'ICEBERG'
          -- 'is_external' = 'false' is implied for managed tables created via Athena DDL
          -- Add other properties like format if needed, though defaults are usually fine
          -- 'write.format.default'='parquet'
        )
      `;

      await executeAthenaQuery(initialEventsQuery, GLUE_DATABASE_NAME, ATHENA_WORKGROUP, queryOutputLocation);
      console.log(`Successfully created table: ${INITIAL_EVENTS_ICEBERG_TABLE_NAME}`);
      console.log("--- Finished Initializing Initial Events Iceberg Table ---");

      // --- Create Events Iceberg Table ---
      console.log(`--- Initializing Events Iceberg Table: ${EVENTS_ICEBERG_TABLE_NAME} ---`);
      await ensureTableDoesNotExist(GLUE_DATABASE_NAME, EVENTS_ICEBERG_TABLE_NAME); // Ensure idempotency

      const eventsColumnsDDL = formatColumnsForDDL(eventsGlueColumns);
      const eventsQuery = `
        CREATE TABLE ${EVENTS_ICEBERG_TABLE_NAME} (
          ${eventsColumnsDDL}
        )
        PARTITIONED BY (site_id, dt) -- Define partitioning columns here
        LOCATION '${eventsTableLocation}'
        TBLPROPERTIES (
          'table_type' = 'ICEBERG'
        )
      `;

      await executeAthenaQuery(eventsQuery, GLUE_DATABASE_NAME, ATHENA_WORKGROUP, queryOutputLocation);
      console.log(`Successfully created table: ${EVENTS_ICEBERG_TABLE_NAME}`);
      console.log("--- Finished Initializing Events Iceberg Table ---");

      return {
          statusCode: 200,
          body: JSON.stringify({ message: "Iceberg tables initialized successfully via Athena DDL." }),
      };
  } catch (error) {
       console.error("Error during Iceberg table initialization process:", error);
       // Ensure the error is propagated correctly for Lambda failure
       throw error instanceof Error ? error : new Error(`Unknown error during table initialization: ${error}`);
  }
}