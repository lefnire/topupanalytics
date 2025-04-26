import {
  FirehoseTransformationEvent,
  FirehoseTransformationHandler,
  FirehoseTransformationResult,
  FirehoseTransformationResultRecord,
} from 'aws-lambda';

/**
 * Processes Firehose records to extract the site_id for dynamic partitioning.
 */
export const handler: FirehoseTransformationHandler = async (
  event: FirehoseTransformationEvent
): Promise<FirehoseTransformationResult> => {
  const outputRecords: FirehoseTransformationResultRecord[] = [];

  for (const record of event.records) {
    try {
      // Decode the base64 data
      const payload = Buffer.from(record.data, 'base64').toString('utf-8');
      const jsonPayload = JSON.parse(payload);

      // Extract the site_id (assuming it's present)
      const siteId = jsonPayload.site_id;

      if (!siteId || typeof siteId !== 'string') {
        console.warn(`Record ${record.recordId} missing or invalid site_id. Marking as ProcessingFailed.`);
        outputRecords.push({
          recordId: record.recordId,
          result: 'ProcessingFailed',
          data: record.data, // Send original data back
        });
        continue; // Skip to the next record
      }

      // Re-encode the original data payload back to base64 (as required by Firehose)
      // The data itself is not modified, only metadata is added.
      const outputRecord: FirehoseTransformationResultRecord = {
        recordId: record.recordId,
        result: 'Ok',
        data: record.data, // Use the original base64 data
        metadata: {
          partitionKeys: {
            site_id: siteId,
          },
        },
      };
      outputRecords.push(outputRecord);

    } catch (error) {
      console.error(`Error processing record ${record.recordId}:`, error);
      // Mark the record as ProcessingFailed if any error occurs during processing
      outputRecords.push({
        recordId: record.recordId,
        result: 'ProcessingFailed',
        data: record.data, // Send original data back
      });
    }
  }

  return { records: outputRecords };
};