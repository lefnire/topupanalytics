import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, QueryExecutionState, GetQueryResultsCommand } from "@aws-sdk/client-athena";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, ObjectIdentifier, CopyObjectCommand } from "@aws-sdk/client-s3";
import { GlueClient, UpdatePartitionCommand, DeleteTableCommand, StorageDescriptor, EntityNotFoundException, GetTableCommand, PartitionInput, CreatePartitionCommand, AlreadyExistsException } from "@aws-sdk/client-glue";

const athena = new AthenaClient({});
const s3 = new S3Client({});
const glue = new GlueClient({});

// Environment variables passed from sst.config.ts
const ATHENA_DATABASE = process.env.ATHENA_DATABASE!;
const ATHENA_INITIAL_EVENTS_TABLE = process.env.ATHENA_INITIAL_EVENTS_TABLE!;
const ATHENA_EVENTS_TABLE = process.env.ATHENA_EVENTS_TABLE!;
const EVENTS_BUCKET_NAME = process.env.EVENTS_BUCKET_NAME!;
// Note: ATHENA_OUTPUT_LOCATION is where Athena query *results* metadata goes,
// not where we store the compacted data before swapping partitions.
const ATHENA_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION!; // Location for query metadata/results

interface CompactionResult {
    table: string;
    status: "success" | "skipped" | "failed";
    reason?: string;
}

/**
 * Runs an Athena query and waits for it to complete.
 * Throws an error if the query fails or is cancelled.
 * @param query The SQL query string to execute.
 * @returns The Query Execution ID.
 */
async function runAthenaQuery(query: string): Promise<string> {
    console.log(`Executing Athena query: ${query}`);
    const startCmd = new StartQueryExecutionCommand({
        QueryString: query,
        QueryExecutionContext: { Database: ATHENA_DATABASE },
        ResultConfiguration: { OutputLocation: ATHENA_OUTPUT_LOCATION }, // Specify output location for query metadata
    });
    const startRes = await athena.send(startCmd);
    const queryExecutionId = startRes.QueryExecutionId;

    if (!queryExecutionId) {
        throw new Error("Failed to start Athena query execution.");
    }
    console.log(`Athena query started with ExecutionId: ${queryExecutionId}`);

    // Poll for completion status
    let status: QueryExecutionState | string | undefined;
    let queryExecution;
    const maxAttempts = 30; // Max attempts (e.g., 30 attempts * 5s = 150s timeout)
    const pollInterval = 5000; // Poll every 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        const getCmd = new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId });
        const getRes = await athena.send(getCmd);
        queryExecution = getRes.QueryExecution;
        status = queryExecution?.Status?.State;

        console.log(`Query ${queryExecutionId} status: ${status}`);

        if (status === QueryExecutionState.SUCCEEDED) {
            console.log(`Athena query ${queryExecutionId} succeeded.`);
            return queryExecutionId;
        } else if (status === QueryExecutionState.FAILED || status === QueryExecutionState.CANCELLED) {
            const reason = queryExecution?.Status?.StateChangeReason;
            const message = `Athena query ${queryExecutionId} failed or was cancelled. State: ${status}. Reason: ${reason}`;
            console.error(message); // Log the reason
             // Try to get more detailed error info if available
            try {
                const resultsCmd = new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId });
                await athena.send(resultsCmd); // This might throw a more specific error if the query failed early
            } catch (resultsError: any) {
                 console.error(`Error fetching results for failed query ${queryExecutionId}:`, resultsError);
                 // Optionally incorporate resultsError.message into the thrown error
            }
            throw new Error(message);
        }
    }

    throw new Error(`Athena query ${queryExecutionId} timed out after ${maxAttempts * pollInterval / 1000} seconds. Final State: ${status}`);
}

/**
 * Deletes all objects under a specific prefix in an S3 bucket.
 * Handles pagination for buckets with many objects.
 * @param bucket The S3 bucket name.
 * @param prefix The prefix (folder path) to delete objects from.
 */
async function deleteS3Prefix(bucket: string, prefix: string) {
    // Ensure prefix ends with '/' to avoid deleting unintended objects
    if (!prefix.endsWith('/')) {
        prefix += '/';
    }
    console.log(`Deleting objects under s3://${bucket}/${prefix}`);
    let isTruncated = true;
    let continuationToken: string | undefined;
    let deletedCount = 0;

    while (isTruncated) {
        const listCmd = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        });
        const listRes = await s3.send(listCmd);

        if (!listRes.Contents || listRes.Contents.length === 0) {
            console.log(`No objects found to delete under s3://${bucket}/${prefix}`);
            break; // Exit loop if no objects found
        }

        const objectsToDelete: ObjectIdentifier[] = listRes.Contents.map(obj => ({ Key: obj.Key! }));

        // Max 1000 objects per DeleteObjects call
        for (let i = 0; i < objectsToDelete.length; i += 1000) {
            const batch = objectsToDelete.slice(i, i + 1000);
            const deleteCmd = new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: batch, Quiet: true }, // Quiet suppresses errors for individual object deletions in the response, but we check Errors array
            });
            const deleteRes = await s3.send(deleteCmd);

            if (deleteRes.Errors && deleteRes.Errors.length > 0) {
                console.error(`Errors deleting objects batch: ${JSON.stringify(deleteRes.Errors)}`);
                // Throwing an error here might leave the process in an inconsistent state.
                // Log the error and potentially continue, or implement retry/manual cleanup.
                throw new Error(`Failed to delete some objects under s3://${bucket}/${prefix}. Check logs.`);
            }
             deletedCount += batch.length;
             console.log(`Deleted ${batch.length} objects batch.`);
        }

        isTruncated = listRes.IsTruncated ?? false;
        continuationToken = listRes.NextContinuationToken;
    }
    console.log(`Finished deleting. Total objects deleted under s3://${bucket}/${prefix}: ${deletedCount}`);
}

/**
 * Moves all objects from a source prefix to a target prefix within the same S3 bucket.
 * Handles pagination and deletes source objects after successful copy.
 * @param bucket The S3 bucket name.
 * @param sourcePrefix The source prefix (folder path) to move objects from.
 * @param targetPrefix The target prefix (folder path) to move objects to.
 */
async function moveS3Prefix(bucket: string, sourcePrefix: string, targetPrefix: string) {
    // Ensure prefixes end with '/'
    if (!sourcePrefix.endsWith('/')) sourcePrefix += '/';
    if (!targetPrefix.endsWith('/')) targetPrefix += '/';

    console.log(`Moving objects from s3://${bucket}/${sourcePrefix} to s3://${bucket}/${targetPrefix}`);
    let isTruncated = true;
    let continuationToken: string | undefined;
    let movedCount = 0;
    const sourcePrefixLength = sourcePrefix.length;

    while (isTruncated) {
        const listCmd = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: sourcePrefix,
            ContinuationToken: continuationToken,
        });
        const listRes = await s3.send(listCmd);

        if (!listRes.Contents || listRes.Contents.length === 0) {
            console.log(`No objects found to move from s3://${bucket}/${sourcePrefix}`);
            break; // Exit loop if no objects found
        }

        const objectsToMove = listRes.Contents;
        const objectsToDeleteAfterCopy: ObjectIdentifier[] = [];

        for (const obj of objectsToMove) {
            const sourceKey = obj.Key!;
            // Ensure we don't copy the "folder" object itself if it exists
            if (sourceKey === sourcePrefix) continue;

            const relativePath = sourceKey.substring(sourcePrefixLength);
            const targetKey = `${targetPrefix}${relativePath}`;
            const copySource = `${bucket}/${sourceKey}`; // Format required by CopyObject

            console.log(`Copying ${sourceKey} to ${targetKey}`);
            const copyCmd = new CopyObjectCommand({
                Bucket: bucket,
                CopySource: copySource,
                Key: targetKey,
            });
            try {
                await s3.send(copyCmd);
                // Add to delete list ONLY after successful copy
                objectsToDeleteAfterCopy.push({ Key: sourceKey });
                movedCount++;
            } catch (copyError) {
                console.error(`Error copying ${sourceKey} to ${targetKey}:`, copyError);
                throw new Error(`Failed to copy object during move operation: ${sourceKey}. Check logs.`);
            }
        }

        // Delete the source objects that were successfully copied in this batch
        if (objectsToDeleteAfterCopy.length > 0) {
            // Max 1000 objects per DeleteObjects call
            for (let i = 0; i < objectsToDeleteAfterCopy.length; i += 1000) {
                const batch = objectsToDeleteAfterCopy.slice(i, i + 1000);
                console.log(`Deleting ${batch.length} source objects after copy.`);
                 const deleteCmd = new DeleteObjectsCommand({
                     Bucket: bucket,
                     Delete: { Objects: batch, Quiet: true },
                 });
                 const deleteRes = await s3.send(deleteCmd);
                 if (deleteRes.Errors && deleteRes.Errors.length > 0) {
                     console.error(`Errors deleting source objects after copy: ${JSON.stringify(deleteRes.Errors)}`);
                     // This indicates a potentially inconsistent state (objects copied but not deleted)
                     throw new Error(`Failed to delete some source objects after copying from s3://${bucket}/${sourcePrefix}. Manual cleanup might be required.`);
                 }
            }
        }

        isTruncated = listRes.IsTruncated ?? false;
        continuationToken = listRes.NextContinuationToken;
    }
    console.log(`Finished moving. Total objects moved from ${sourcePrefix} to ${targetPrefix}: ${movedCount}`);
}

/**
 * Main handler function triggered by the SST Cron job.
 */
export async function handler(event: any): Promise<{ status: string; message?: string }> {
    console.log("Starting Athena compaction job...", JSON.stringify(event));

    // 1. Determine the target date partition (yesterday in UTC)
    // NOTE: leave the hard-coded date in for now, I'm in dev mode currently and
    // testing this for various dates. I'll switch this back when I launch
    // const targetDate = new Date();
    // targetDate.setUTCDate(targetDate.getUTCDate() - 1); // Yesterday
    // const year = targetDate.getUTCFullYear();
    // const month = (targetDate.getUTCMonth() + 1).toString().padStart(2, '0');
    // const day = targetDate.getUTCDate().toString().padStart(2, '0');
    const [year, month, day] = ["2025", "04", "23"]
    const partitionDtValue = `${year}-${month}-${day}`;
    // const partitionValues = [partitionDtValue]; // Glue expects an array // No longer needed

    console.log(`Compacting partition dt=${partitionDtValue}`);

    const tablesToCompact = [ATHENA_INITIAL_EVENTS_TABLE, ATHENA_EVENTS_TABLE];
    const results: CompactionResult[] = [];

    for (const originalTableName of tablesToCompact) {
        console.log(`\n--- Processing table: ${originalTableName} ---`);

        // Define names and locations
        const tempTableName = `${originalTableName}_compact_${year}_${month}_${day}`;
        const compactedDataPrefix = `compacted/${originalTableName}/dt=${partitionDtValue}/`; // S3 prefix for compacted data
        const compactedDataLocation = `s3://${EVENTS_BUCKET_NAME}/${compactedDataPrefix}`;
        let originalTableStorageDescriptor: StorageDescriptor | undefined;
        let originalPartitionS3Prefix: string | undefined;

        try {
            // 1. Get the TABLE's storage descriptor to find original location
            try {
                 const getTableCmd = new GetTableCommand({
                    DatabaseName: ATHENA_DATABASE,
                    Name: originalTableName,
                });
                const tableInfo = await glue.send(getTableCmd);
                if (!tableInfo.Table?.StorageDescriptor?.Location) {
                    throw new Error(`Could not retrieve table storage descriptor or location for ${originalTableName}`);
                }
                originalTableStorageDescriptor = tableInfo.Table.StorageDescriptor;
                // Calculate the original S3 prefix for this partition
                const baseLocation = originalTableStorageDescriptor?.Location?.endsWith('/')
                    ? originalTableStorageDescriptor?.Location
                    : `${originalTableStorageDescriptor?.Location}/`;
                if (!baseLocation || baseLocation === 'undefined/') { // Check if location was undefined
                    throw new Error(`Could not resolve base location from table descriptor for ${originalTableName}`);
                }
                originalPartitionS3Prefix = `${baseLocation}dt=${partitionDtValue}/`;
                // Basic validation of the calculated prefix
                const url = new URL(originalPartitionS3Prefix);
                if (url.protocol !== "s3:" || url.hostname !== EVENTS_BUCKET_NAME) {
                    throw new Error(`Calculated original partition location ${originalPartitionS3Prefix} seems invalid (wrong bucket or protocol).`);
                }
                originalPartitionS3Prefix = url.pathname.substring(1); // Remove leading '/' for prefix usage
                 console.log(`Retrieved base storage descriptor from table ${originalTableName}`);
                 console.log(`Original partition prefix determined as: ${originalPartitionS3Prefix}`);

            } catch (getTableError) {
                 console.error(`Failed to get table info or determine original location for ${originalTableName}:`, getTableError);
                 results.push({ table: originalTableName, status: "failed", reason: `Failed to get table info/location: ${(getTableError as Error).message}` });
                 continue; // Skip to next table
            }

             // Ensure originalPartitionS3Prefix is defined before proceeding
            if (!originalPartitionS3Prefix) {
                 throw new Error(`Internal error: Original S3 partition prefix could not be determined for ${originalTableName}`);
            }

            // 2. Run CTAS query to create compacted data
            const ctasQuery = `
                CREATE TABLE "${tempTableName}"
                WITH (
                    format = 'PARQUET',
                    parquet_compression = 'SNAPPY',
                    external_location = '${compactedDataLocation}'
                ) AS
                SELECT *
                FROM "${originalTableName}"
                WHERE dt = '${partitionDtValue}'
            `;
            await runAthenaQuery(ctasQuery);
            console.log(`CTAS query completed. Compacted data created in ${compactedDataLocation}`);

            // 3. Delete original partition data from S3
            console.log(`Attempting deletion of original data at: s3://${EVENTS_BUCKET_NAME}/${originalPartitionS3Prefix}`);
            await deleteS3Prefix(EVENTS_BUCKET_NAME, originalPartitionS3Prefix);
            console.log(`Successfully deleted original data from s3://${EVENTS_BUCKET_NAME}/${originalPartitionS3Prefix}`);

            // 4. Move compacted data from temporary location to original location
            console.log(`Attempting to move compacted data from s3://${EVENTS_BUCKET_NAME}/${compactedDataPrefix} to s3://${EVENTS_BUCKET_NAME}/${originalPartitionS3Prefix}`);
            if (compactedDataPrefix === originalPartitionS3Prefix) {
                 console.warn(`Source prefix ${compactedDataPrefix} and target prefix ${originalPartitionS3Prefix} are the same. Skipping move operation.`);
                 // This shouldn't happen with the defined prefixes, but good to check.
            } else {
                await moveS3Prefix(EVENTS_BUCKET_NAME, compactedDataPrefix, originalPartitionS3Prefix);
                console.log(`Successfully moved compacted data to s3://${EVENTS_BUCKET_NAME}/${originalPartitionS3Prefix}`);
            }

            // 5. Mark as success
            console.log(`Compaction successful via S3 replace for table ${originalTableName}, partition dt=${partitionDtValue}.`);
            results.push({ table: originalTableName, status: "success" });

        } catch (error: any) {
             // Catch errors from GetTable, CTAS, Delete, or Move steps
             if (error instanceof EntityNotFoundException) {
                 // This might occur during GetTable if the table itself is gone.
                 console.warn(`EntityNotFoundException encountered for ${originalTableName}. Skipping. Error: ${error.message}`);
                 results.push({ table: originalTableName, status: "skipped", reason: `Entity not found: ${error.message}` });
             } else {
                 // Log specific error context (e.g., during delete, move) if possible, otherwise general error.
                 console.error(`Error compacting table ${originalTableName}, partition dt=${partitionDtValue}:`, error);
                 results.push({ table: originalTableName, status: "failed", reason: error.message });
            }
            // Note: No Glue partition changes were attempted, so no specific cleanup needed there on failure.
            // The temporary Athena table is cleaned up in 'finally'.
            // Potential partial state: CTAS succeeded, original delete failed OR delete succeeded, move failed. Needs monitoring.

        } finally {
            // 6. Clean up: Drop the temporary Athena table created by CTAS
            try {
                const deleteTableCmd = new DeleteTableCommand({
                    DatabaseName: ATHENA_DATABASE,
                    Name: tempTableName,
                });
                console.log(`Attempting to drop temporary table: ${tempTableName}`);
                await glue.send(deleteTableCmd);
                console.log(`Successfully dropped temporary table: ${tempTableName}`);
            } catch (error) {
                if (error instanceof EntityNotFoundException) {
                    console.log(`Temporary table ${tempTableName} not found, likely already deleted or CTAS failed.`);
                } else {
                    // Log error but don't fail the overall job just because temp table cleanup failed
                    console.error(`Error dropping temporary table ${tempTableName}:`, error);
                }
            }

             // 7. Clean up: Delete the temporary COMPACTED data folder (redundant after successful move)
             // We attempt this even if the main process failed, in case CTAS succeeded but later steps failed.
            console.log(`Attempting cleanup of temporary compacted data at: s3://${EVENTS_BUCKET_NAME}/${compactedDataPrefix}`);
            try {
                 // Check if compactedDataPrefix is valid and different from original before deleting
                if (compactedDataPrefix && originalPartitionS3Prefix && compactedDataPrefix !== originalPartitionS3Prefix) {
                     await deleteS3Prefix(EVENTS_BUCKET_NAME, compactedDataPrefix);
                     console.log(`Successfully cleaned up temporary compacted data s3://${EVENTS_BUCKET_NAME}/${compactedDataPrefix}`);
                } else if (compactedDataPrefix === originalPartitionS3Prefix) {
                     console.log(`Temporary compacted prefix is same as original, skipping cleanup.`);
                } else {
                     console.log(`Temporary compacted prefix was not determined, skipping cleanup.`);
                }
            } catch (cleanupError) {
                console.error(`Error cleaning up temporary compacted data s3://${EVENTS_BUCKET_NAME}/${compactedDataPrefix}:`, cleanupError);
                // Log error but don't mark the job as failed solely for this cleanup issue.
            }

            console.log(`--- Finished processing table: ${originalTableName} ---`);
        }
    } // End loop over tables

    console.log("\nAthena compaction job finished. Results:", JSON.stringify(results));
    const overallStatus = results.every(r => r.status === 'success' || r.status === 'skipped') ? "Completed" : "Completed with errors";
    return { status: overallStatus };
}
