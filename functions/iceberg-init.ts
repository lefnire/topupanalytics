import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, QueryExecutionState } from "@aws-sdk/client-athena";
import { GlueClient, CreateTableCommand, DeleteTableCommand, GetTableCommand, StorageDescriptor, Column, AlreadyExistsException, EntityNotFoundException } from "@aws-sdk/client-glue";
import { setTimeout } from "timers/promises";

// Environment variables expected from SST link bindings
const GLUE_DATABASE_NAME = process.env.GLUE_DATABASE_NAME;
const SOURCE_INITIAL_EVENTS_TABLE_NAME = process.env.SOURCE_INITIAL_EVENTS_TABLE_NAME;
const SOURCE_EVENTS_TABLE_NAME = process.env.SOURCE_EVENTS_TABLE_NAME;
const EVENTS_BUCKET_NAME = process.env.EVENTS_BUCKET_NAME;
const QUERY_RESULTS_BUCKET_NAME = process.env.QUERY_RESULTS_BUCKET_NAME;

const athena = new AthenaClient({});
const glue = new GlueClient({}); // Add Glue client
const MAX_POLL_ATTEMPTS = 60; // Max attempts (e.g., 60 attempts * 5 seconds = 5 minutes)
const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

interface IcebergInitEvent {
  INITIAL_EVENTS_ICEBERG_TABLE_NAME: string;
  EVENTS_ICEBERG_TABLE_NAME: string;
  ATHENA_WORKGROUP: string;
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
      // If state is QUEUED or RUNNING, wait and poll again
    } catch (error) {
      console.error(`Error polling query ${queryExecutionId}:`, error);
      // Rethrow specific errors or handle transient issues if needed
      throw error; // Rethrow for Lambda failure
    }
    await setTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(`Query ${queryExecutionId} did not complete within the maximum polling time.`);
}

// Helper function to execute a query and wait for completion
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
        if (error instanceof Error) {
             // Try to extract Athena error message if available
             const message = error.message || "Unknown Athena execution error";
             throw new Error(message); // Throw a standard Error
        } else {
             throw new Error("Unknown Athena execution error occurred.");
        }
    }
}

// Helper function to create a temporary non-projected Glue table
async function createTemporaryGlueTable(tempTableName: string, sourceTableName: string, s3Location: string): Promise<void> {
    console.log(`Creating temporary Glue table: ${tempTableName} pointing to ${s3Location}`);
    try {
        // Get schema from original source table
        const getTableCmd = new GetTableCommand({ DatabaseName: GLUE_DATABASE_NAME, Name: sourceTableName });
        const getTableResponse = await glue.send(getTableCmd);
        const tableColumns = getTableResponse.Table?.StorageDescriptor?.Columns;

        if (!tableColumns) {
            throw new Error(`Could not retrieve columns for source table ${sourceTableName}`);
        }

        const createTableCmd = new CreateTableCommand({
            DatabaseName: GLUE_DATABASE_NAME,
            TableInput: {
                Name: tempTableName,
                TableType: "EXTERNAL_TABLE",
                Parameters: {
                   "external": "TRUE",
                   "classification": "parquet",
                   // No projection parameters needed
                },
                 StorageDescriptor: {
                    Columns: tableColumns,
                    Location: s3Location,
                    InputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
                    OutputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
                    SerdeInfo: {
                        SerializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
                        Parameters: { "serialization.format": "1" }
                    },
                    Compressed: false,
                    StoredAsSubDirectories: true,
                 },
                 // NO PartitionKeys for the temp table
            },
        });
        await glue.send(createTableCmd);
        console.log(`Successfully created temporary table: ${tempTableName}`);
    } catch (error) {
        if (error instanceof AlreadyExistsException) {
             console.warn(`Temporary table ${tempTableName} already exists. Assuming it's usable.`);
             return; // Don't fail if it already exists from a previous partial run
        }
        console.error(`Error creating temporary table ${tempTableName}:`, error);
        throw error; // Rethrow other errors
    }
}

// Helper function to delete temporary Glue table
async function deleteTemporaryGlueTable(tempTableName: string): Promise<void> {
    console.log(`Deleting temporary Glue table: ${tempTableName}`);
    try {
        const deleteCmd = new DeleteTableCommand({ DatabaseName: GLUE_DATABASE_NAME, Name: tempTableName });
        await glue.send(deleteCmd);
        console.log(`Successfully deleted temporary table: ${tempTableName}`);
    } catch (error) {
         if (error instanceof EntityNotFoundException) {
            console.warn(`Temporary table ${tempTableName} not found for deletion. Skipping.`);
            return;
         }
        console.error(`Error deleting temporary table ${tempTableName}:`, error);
        // Log error but don't fail the overall process just for cleanup failure
    }
}

// Helper to get all column names (storage + partition)
async function getAllSourceColumnNames(tableName: string): Promise<string[]> {
    const getTableCmd = new GetTableCommand({ DatabaseName: GLUE_DATABASE_NAME, Name: tableName });
    const getTableResponse = await glue.send(getTableCmd);
    const storageCols = getTableResponse.Table?.StorageDescriptor?.Columns?.map(c => c.Name ?? '').filter(n => n) ?? [];
    const partitionCols = getTableResponse.Table?.PartitionKeys?.map(pk => pk.Name ?? '').filter(n => n) ?? [];
    if (storageCols.length === 0 && partitionCols.length === 0) {
        throw new Error(`Could not retrieve any columns for source table ${tableName}`);
    }
    return [...storageCols, ...partitionCols];
}

export async function handler(event: IcebergInitEvent): Promise<any> {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // Validate required environment variables
  if (!GLUE_DATABASE_NAME || !SOURCE_INITIAL_EVENTS_TABLE_NAME || !SOURCE_EVENTS_TABLE_NAME || !EVENTS_BUCKET_NAME || !QUERY_RESULTS_BUCKET_NAME) {
    throw new Error("Missing required environment variables from SST bindings.");
  }
  // Validate required event payload properties
  if (!event.INITIAL_EVENTS_ICEBERG_TABLE_NAME || !event.EVENTS_ICEBERG_TABLE_NAME || !event.ATHENA_WORKGROUP) {
      throw new Error("Missing required properties in the event payload.");
  }

  const {
    INITIAL_EVENTS_ICEBERG_TABLE_NAME,
    EVENTS_ICEBERG_TABLE_NAME,
    ATHENA_WORKGROUP,
  } = event;

  const queryOutputLocation = `s3://${QUERY_RESULTS_BUCKET_NAME}/iceberg-init-ddl/`;
  const tempInitialEventsTable = `${SOURCE_INITIAL_EVENTS_TABLE_NAME}_temp_init`;
  const tempEventsTable = `${SOURCE_EVENTS_TABLE_NAME}_temp_init`;

  try {
      // --- Create Initial Events Iceberg Table ---
      console.log("--- Initializing Initial Events Iceberg Table ---");
      await createTemporaryGlueTable(tempInitialEventsTable, SOURCE_INITIAL_EVENTS_TABLE_NAME!, `s3://${EVENTS_BUCKET_NAME}/initial_events/`); // Added non-null assertion

      // Get column names for explicit SELECT
      const initialCols = await getAllSourceColumnNames(SOURCE_INITIAL_EVENTS_TABLE_NAME!); // Added non-null assertion
      const initialSelectCols = initialCols.map(col => `\"${col}\"`).join(', '); // Quote column names

      const initialEventsQuery = `
        CREATE TABLE IF NOT EXISTS \"${GLUE_DATABASE_NAME}\".\"${INITIAL_EVENTS_ICEBERG_TABLE_NAME}\"
        WITH (
          table_type='ICEBERG',
          format='PARQUET',
          location='s3://${EVENTS_BUCKET_NAME}/initial_events_iceberg_data/',
          partitioning=ARRAY['site_id','dt']
        ) AS
        SELECT ${initialSelectCols} FROM \"${GLUE_DATABASE_NAME}\".\"${tempInitialEventsTable}\"
      `;

      await executeAthenaQuery(initialEventsQuery, GLUE_DATABASE_NAME!, ATHENA_WORKGROUP, queryOutputLocation); // Added non-null assertion
      console.log(`Successfully executed CTAS for table: ${INITIAL_EVENTS_ICEBERG_TABLE_NAME}`);
      await deleteTemporaryGlueTable(tempInitialEventsTable); // Cleanup
      console.log("--- Finished Initializing Initial Events Iceberg Table ---");

      // --- Create Events Iceberg Table ---
      console.log("--- Initializing Events Iceberg Table ---");
      await createTemporaryGlueTable(tempEventsTable, SOURCE_EVENTS_TABLE_NAME!, `s3://${EVENTS_BUCKET_NAME}/events/`); // Added non-null assertion

      // Get column names for explicit SELECT
      const eventsCols = await getAllSourceColumnNames(SOURCE_EVENTS_TABLE_NAME!); // Added non-null assertion
      const eventsSelectCols = eventsCols.map(col => `\"${col}\"`).join(', '); // Quote column names

      const eventsQuery = `
        CREATE TABLE IF NOT EXISTS \"${GLUE_DATABASE_NAME}\".\"${EVENTS_ICEBERG_TABLE_NAME}\"
        WITH (
          table_type='ICEBERG',
          format='PARQUET',
          location='s3://${EVENTS_BUCKET_NAME}/events_iceberg_data/',
          partitioning=ARRAY['site_id','dt']
        ) AS
        SELECT ${eventsSelectCols} FROM \"${GLUE_DATABASE_NAME}\".\"${tempEventsTable}\"
      `;

      await executeAthenaQuery(eventsQuery, GLUE_DATABASE_NAME!, ATHENA_WORKGROUP, queryOutputLocation); // Added non-null assertion
      console.log(`Successfully executed CTAS for table: ${EVENTS_ICEBERG_TABLE_NAME}`);
      await deleteTemporaryGlueTable(tempEventsTable); // Cleanup
      console.log("--- Finished Initializing Events Iceberg Table ---");

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Iceberg tables initialized successfully." }),
      };
  } catch (error) {
       console.error("Error during Iceberg initialization process:", error);
       // Attempt cleanup even on failure
       await deleteTemporaryGlueTable(tempInitialEventsTable);
       await deleteTemporaryGlueTable(tempEventsTable);
       throw error instanceof Error ? error : new Error(`Unknown error during initialization: ${error}`);
  }
} 