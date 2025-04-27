import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, QueryExecutionState } from "@aws-sdk/client-athena";
import { GlueClient, GetTableCommand, Column } from "@aws-sdk/client-glue"; // Removed unused Glue imports
import { setTimeout } from "timers/promises";

// Environment variables expected from SST link bindings
const GLUE_DATABASE_NAME = process.env.GLUE_DATABASE_NAME;
const SOURCE_INITIAL_EVENTS_TABLE_NAME = process.env.SOURCE_INITIAL_EVENTS_TABLE_NAME;
const SOURCE_EVENTS_TABLE_NAME = process.env.SOURCE_EVENTS_TABLE_NAME;
const EVENTS_BUCKET_NAME = process.env.EVENTS_BUCKET_NAME;
const QUERY_RESULTS_BUCKET_NAME = process.env.QUERY_RESULTS_BUCKET_NAME;

const athena = new AthenaClient({});
const glue = new GlueClient({});
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 5000;

interface IcebergInitEvent {
  INITIAL_EVENTS_ICEBERG_TABLE_NAME: string;
  EVENTS_ICEBERG_TABLE_NAME: string;
  ATHENA_WORKGROUP: string;
}

// Helper function to wait for Athena query completion (simplified error handling)
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
      throw error; // Rethrow for Lambda failure
    }
    await setTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(`Query ${queryExecutionId} did not complete within the maximum polling time.`);
}

// Helper function to execute a query and wait for completion (simplified error handling)
async function executeAthenaQuery(queryString: string, databaseName: string, workgroup: string, outputLocation: string): Promise<void> {
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

    } catch (error) {
        console.error("Athena query execution failed:", error);
        // Throw the original error or a generic one
        throw error instanceof Error ? error : new Error("Unknown Athena execution error occurred.");
    }
}

// Helper to get schema definition string from source table
async function getSourceSchemaDefinition(tableName: string): Promise<string> {
    console.log(`Getting schema definition for source table: ${tableName}`);
    const getTableCmd = new GetTableCommand({ DatabaseName: GLUE_DATABASE_NAME, Name: tableName });
    const getTableResponse = await glue.send(getTableCmd);
    const storageCols = getTableResponse.Table?.StorageDescriptor?.Columns ?? [];
    const partitionCols = getTableResponse.Table?.PartitionKeys ?? [];

    const allCols = [...storageCols, ...partitionCols];

    if (allCols.length === 0) {
        throw new Error(`Could not retrieve any columns for source table ${tableName}`);
    }

    // Format as \"col_name\" col_type - Use double quotes for safety
    return allCols.map(col => `\"${col.Name}\" ${col.Type}`).join(',\n  ');
}

export async function handler(event: IcebergInitEvent): Promise<any> {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // Validate environment variables
  if (!GLUE_DATABASE_NAME || !SOURCE_INITIAL_EVENTS_TABLE_NAME || !SOURCE_EVENTS_TABLE_NAME || !EVENTS_BUCKET_NAME || !QUERY_RESULTS_BUCKET_NAME) {
    throw new Error("Missing required environment variables from SST bindings.");
  }
  // Validate event payload
  if (!event.INITIAL_EVENTS_ICEBERG_TABLE_NAME || !event.EVENTS_ICEBERG_TABLE_NAME || !event.ATHENA_WORKGROUP) {
      throw new Error("Missing required properties in the event payload.");
  }

  const {
    INITIAL_EVENTS_ICEBERG_TABLE_NAME,
    EVENTS_ICEBERG_TABLE_NAME,
    ATHENA_WORKGROUP,
  } = event;

  const queryOutputLocation = `s3://${QUERY_RESULTS_BUCKET_NAME}/iceberg-init-ddl/`;

  try {
      // --- Create Initial Events Iceberg Table (Empty via CTAS) ---
      console.log("--- Initializing Initial Events Iceberg Table (CTAS) ---");

      const initialEventsQuery = `
        CREATE TABLE IF NOT EXISTS ${INITIAL_EVENTS_ICEBERG_TABLE_NAME}
        WITH (
          table_type = 'ICEBERG',
          is_external = false, -- Explicitly create a managed table
          location = 's3://${EVENTS_BUCKET_NAME}/${INITIAL_EVENTS_ICEBERG_TABLE_NAME}/', -- Explicit location required
          partitioning = ARRAY['site_id','dt']
        ) AS
        SELECT * FROM ${SOURCE_INITIAL_EVENTS_TABLE_NAME} WHERE 1 = 0
      `;

      await executeAthenaQuery(initialEventsQuery, GLUE_DATABASE_NAME!, ATHENA_WORKGROUP, queryOutputLocation);
      console.log(`Successfully created or verified schema for table: ${INITIAL_EVENTS_ICEBERG_TABLE_NAME}`);
      console.log("--- Finished Initializing Initial Events Iceberg Table ---");

      // --- Create Events Iceberg Table (Empty via CTAS) ---
      console.log("--- Initializing Events Iceberg Table (CTAS) ---");

      const eventsQuery = `
        CREATE TABLE IF NOT EXISTS ${EVENTS_ICEBERG_TABLE_NAME}
        WITH (
          table_type = 'ICEBERG',
          is_external = false, -- Explicitly create a managed table
          location = 's3://${EVENTS_BUCKET_NAME}/${EVENTS_ICEBERG_TABLE_NAME}/', -- Explicit location required
          partitioning = ARRAY['site_id','dt']
        ) AS
        SELECT * FROM ${SOURCE_EVENTS_TABLE_NAME} WHERE 1 = 0
      `;

      await executeAthenaQuery(eventsQuery, GLUE_DATABASE_NAME!, ATHENA_WORKGROUP, queryOutputLocation);
      console.log(`Successfully created or verified schema for table: ${EVENTS_ICEBERG_TABLE_NAME}`);
      console.log("--- Finished Initializing Events Iceberg Table ---");

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Empty Iceberg tables initialized successfully." }),
      };
  } catch (error) {
       console.error("Error during Iceberg schema initialization process:", error);
       throw error instanceof Error ? error : new Error(`Unknown error during schema initialization: ${error}`);
  }
} 