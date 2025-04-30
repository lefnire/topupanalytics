import { FirehoseTransformationEvent, FirehoseTransformationResult } from 'aws-lambda'; // Use FirehoseTransformation types
import { gunzipSync } from 'node:zlib'; // Import specific function
import { Buffer } from 'node:buffer';
import { db } from '../../shared/db/client';
import { sites, events, initialEvents } from '../../shared/db/schema'; // Use correct table names (camelCase)
import { eq, and, gte, sql } from 'drizzle-orm';
import { FirehoseClient, PutRecordBatchCommand, _Record as FirehoseRecord } from "@aws-sdk/client-firehose"; // Use _Record as suggested
// TODO: Add ua-parser-js and geoip-lite if needed for detailed enrichment
// import uaParser from 'ua-parser-js';
// import geoip from 'geoip-lite';

const firehoseClient = new FirehoseClient({});

// Environment variables for target Firehose streams (Set by SST)
const EVENTS_FIREHOSE_NAME = process.env.EVENTS_FIREHOSE_NAME!;
const INITIAL_EVENTS_FIREHOSE_NAME = process.env.INITIAL_EVENTS_FIREHOSE_NAME!;

interface DecodedRecordData {
  site_id: string;
  // Assuming the original event payload structure includes destination and event details
  destination: 'events' | 'initial_events';
  event_name?: string; // Example field
  hostname?: string; // Example field for domain validation
  timestamp: string; // ISO string
  // ... other raw event properties
  [key: string]: any; // Allow flexible event properties
}

// Infer SiteConfig type from the Drizzle schema
type SiteConfig = typeof sites.$inferSelect;
// Infer Event types from Drizzle schema
type EventInsert = typeof events.$inferInsert;
type InitialEventInsert = typeof initialEvents.$inferInsert;


// Basic enrichment function (expand as needed)
// Returns Partial<InitialEventInsert> as it includes all potential enriched fields
function enrichRecord(recordData: DecodedRecordData, siteConfig: SiteConfig): Partial<InitialEventInsert> {
  const enriched: Partial<InitialEventInsert> = {
    dt: recordData.timestamp.substring(0, 10), // Extract YYYY-MM-DD

    // Placeholder enrichment - copy from recordData if exists, otherwise undefined
    // TODO: Implement actual enrichment logic using libraries like ua-parser-js, geoip-lite etc.
    referer: recordData.referer,
    refererDomain: recordData.referer_domain, // Assuming snake_case in raw data
    utmSource: recordData.utm_source,
    utmMedium: recordData.utm_medium,
    utmCampaign: recordData.utm_campaign,
    utmContent: recordData.utm_content,
    utmTerm: recordData.utm_term,
    device: recordData.device, // Placeholder: derive from user_agent
    os: recordData.os, // Placeholder: derive from user_agent
    browser: recordData.browser, // Placeholder: derive from user_agent
    country: recordData.country, // Placeholder: derive from ip_address
    region: recordData.region, // Placeholder: derive from ip_address
    city: recordData.city, // Placeholder: derive from ip_address
    screenWidth: recordData.screen_width,
    screenHeight: recordData.screen_height,
    properties: recordData.properties, // Pass through existing properties
  };
  return enriched;
}

// Compliance filtering function (expand based on actual PII fields)
function applyCompliance(recordData: DecodedRecordData, siteConfig: SiteConfig): DecodedRecordData {
  if (siteConfig.complianceLevel === 2) { // "no" - strictest (Use camelCase)
    // Remove potentially sensitive fields aggressively
    delete recordData.ip_address;
    delete recordData.user_agent;
    // ... remove other fields based on schema and compliance rules
  } else if (siteConfig.complianceLevel === 1) { // "maybe" (Use camelCase)
    // Apply moderate filtering
    // e.g., anonymize IP? Remove specific query params?
  }
  // Level 0 ("yes") - assume no filtering needed, or minimal based on event type

  return recordData;
}

export const handler = async (event: FirehoseTransformationEvent): Promise<FirehoseTransformationResult> => { // Use correct event/result types
  console.log(`Received event with ${event.records.length} records.`);
  const siteConfigCache = new Map<string, SiteConfig | null>(); // Cache site configs, null if not found
  const siteAllowanceDecrement = new Map<string, number>(); // Track valid events per site

  const auroraEventsToInsert: EventInsert[] = []; // Use inferred insert type
  const auroraInitialEventsToInsert: InitialEventInsert[] = [];
  const s3RecordsToForward: { destination: 'events' | 'initial_events'; data: Buffer }[] = [];
  const results: FirehoseTransformationResult['records'] = []; // Store individual record results

  for (const record of event.records) { // Iterate directly to manage scope better
    let recordResultStatus: FirehoseTransformationResult['records'][0]['result'] = 'Ok'; // Default to Ok
    try {
      // 1. Decode and Decompress Record Data
      const payloadBuffer = Buffer.from(record.data, 'base64');
      // Assuming Gzip compression was enabled in the source Firehose/ingestFn
      const decompressedBuffer = gunzipSync(payloadBuffer); // Use imported gunzipSync
      const jsonPayload = decompressedBuffer.toString('utf-8');
      const recordData: DecodedRecordData = JSON.parse(jsonPayload);

      const siteId = recordData.site_id;
      if (!siteId) {
        console.warn('Record missing site_id, skipping:', record.recordId);
        recordResultStatus = 'ProcessingFailed'; // Mark as failed
        // Add result and continue to next record
        results.push({ recordId: record.recordId, result: recordResultStatus, data: record.data });
        continue; // Use continue to skip this iteration
      }

      // 2. Fetch/Cache Site Configuration
      let siteConfig = siteConfigCache.get(siteId);
      if (siteConfig === undefined) { // Not in cache yet
        const result = await db.select()
          .from(sites)
          .where(eq(sites.siteId, siteId))
          .limit(1);
        siteConfig = result.length > 0 ? result[0] : null;
        siteConfigCache.set(siteId, siteConfig);
        console.log(`Fetched config for site ${siteId}: ${siteConfig ? 'Found' : 'Not Found'}`);
      }

      if (!siteConfig) {
        console.warn(`Site config not found for site_id ${siteId}, skipping record:`, record.recordId);
        recordResultStatus = 'ProcessingFailed'; // Mark as failed
        results.push({ recordId: record.recordId, result: recordResultStatus, data: record.data });
        continue; // Use continue
      }

      // 3. Filtering, Validation & Enrichment
      // Allowance Check
      if (siteConfig.requestAllowance <= 0) { // Use camelCase
        console.log(`Site ${siteId} allowance depleted, skipping record:`, record.recordId);
        recordResultStatus = 'ProcessingFailed'; // Mark as failed
        results.push({ recordId: record.recordId, result: recordResultStatus, data: record.data });
        continue; // Use continue
      }

      // Domain Validation (Example: using hostname field)
      const eventHostname = recordData.hostname; // Adjust based on actual event field
      const allowedDomains = siteConfig.domains || []; // Use camelCase
      if (eventHostname && !allowedDomains.some(domain => eventHostname.endsWith(domain))) {
         console.log(`Domain mismatch for site ${siteId} (${eventHostname} vs ${allowedDomains.join(',')}), skipping record:`, record.recordId);
         recordResultStatus = 'ProcessingFailed'; // Mark as failed
         results.push({ recordId: record.recordId, result: recordResultStatus, data: record.data });
         continue; // Use continue
      }

      // Apply Compliance Filtering (Mutates recordData)
      let processedData = applyCompliance({ ...recordData }, siteConfig);

      // Enrichment (Only for initial_events destination)
      let enrichedFields: Partial<InitialEventInsert> = {}; // Now returns more fields
      if (processedData.destination === 'initial_events') {
        enrichedFields = enrichRecord(processedData, siteConfig);
      }

      // Prepare data for S3 forwarding (original valid, processed data)
      const s3DataBuffer = Buffer.from(JSON.stringify(processedData)); // Stringify before enrichment/DB mapping
      s3RecordsToForward.push({ destination: recordData.destination, data: s3DataBuffer });

      // Prepare final record structure for Aurora DB Insert
      const dbTimestamp = new Date(processedData.timestamp);
      const dbDt = enrichedFields.dt || processedData.timestamp.substring(0, 10); // Ensure dt is set

      // Map common required fields (ensure these exist in DecodedRecordData)
      // Use Drizzle schema field names (camelCase)
      const baseDbRecord = {
        siteId: siteId,
        sessionId: processedData.session_id || 'missing_session', // Provide default if missing
        timestamp: dbTimestamp,
        dt: dbDt,
        event: processedData.event_name || 'unknown', // Map event_name to event, provide default
        pathname: processedData.pathname || '/', // Provide default
        properties: processedData.properties || enrichedFields.properties || undefined, // Optional JSONB
      };

      // Add to appropriate lists for bulk operations
      if (recordData.destination === 'events') {
        const eventRecord: EventInsert = {
          ...baseDbRecord,
          // No extra fields needed based on schema for 'events' beyond base
        };
        auroraEventsToInsert.push(eventRecord);
      } else if (recordData.destination === 'initial_events') {
        const initialEventRecord: InitialEventInsert = {
          ...baseDbRecord,
          // Map additional optional fields from processedData or enrichedFields
          // Use Drizzle schema field names (camelCase)
          referer: processedData.referer || enrichedFields.referer,
          refererDomain: processedData.referer_domain || enrichedFields.refererDomain,
          utmSource: processedData.utm_source || enrichedFields.utmSource,
          utmMedium: processedData.utm_medium || enrichedFields.utmMedium,
          utmCampaign: processedData.utm_campaign || enrichedFields.utmCampaign,
          utmContent: processedData.utm_content || enrichedFields.utmContent,
          utmTerm: processedData.utm_term || enrichedFields.utmTerm,
          device: processedData.device || enrichedFields.device,
          os: processedData.os || enrichedFields.os,
          browser: processedData.browser || enrichedFields.browser,
          country: processedData.country || enrichedFields.country,
          region: processedData.region || enrichedFields.region,
          city: processedData.city || enrichedFields.city,
          screenWidth: processedData.screen_width || enrichedFields.screenWidth,
          screenHeight: processedData.screen_height || enrichedFields.screenHeight,
        };
        auroraInitialEventsToInsert.push(initialEventRecord);
      }

      // Increment allowance decrement counter
      siteAllowanceDecrement.set(siteId, (siteAllowanceDecrement.get(siteId) || 0) + 1);

    } catch (error: any) {
      console.error(`Error processing record ${record.recordId}:`, error.message, error.stack);
      recordResultStatus = 'ProcessingFailed'; // Mark record as failed
      // Continue processing other records in the finally block
    } finally {
       // Add result for this record (Ok or ProcessingFailed)
       results.push({
         recordId: record.recordId,
         result: recordResultStatus,
         data: record.data, // Return original base64 data as required by Firehose
       });
    }
  } // End of for loop

  // Now perform bulk operations outside the loop
  console.log(`Processed records. Aurora Events: ${auroraEventsToInsert.length}, Aurora InitialEvents: ${auroraInitialEventsToInsert.length}, S3 Forward: ${s3RecordsToForward.length}`);

  // 4. Bulk Insert to Aurora
  const auroraInsertPromises: Promise<any>[] = [];
  if (auroraEventsToInsert.length > 0) {
    console.log(`Inserting ${auroraEventsToInsert.length} records into 'events' table...`);
    // Using Drizzle's bulk insert. Monitor performance; switch to COPY FROM if needed for very large batches.
    auroraInsertPromises.push(
      db.insert(events).values(auroraEventsToInsert)
        .catch(err => console.error("Error inserting into 'events':", err))
    );
  }
  if (auroraInitialEventsToInsert.length > 0) {
    console.log(`Inserting ${auroraInitialEventsToInsert.length} records into 'initial_events' table...`);
    auroraInsertPromises.push(
      db.insert(initialEvents).values(auroraInitialEventsToInsert) // Use correct table name
        .catch(err => console.error("Error inserting into 'initial_events':", err))
    );
  }

  // 5. Forward to S3/Iceberg Firehose
  const s3ForwardPromises: Promise<any>[] = [];
  const recordsForEventsStream: FirehoseRecord[] = [];
  const recordsForInitialEventsStream: FirehoseRecord[] = [];

  s3RecordsToForward.forEach(record => {
    const firehoseRecord = { Data: record.data };
    if (record.destination === 'events') {
      recordsForEventsStream.push(firehoseRecord);
    } else {
      recordsForInitialEventsStream.push(firehoseRecord);
    }
  });

  if (recordsForEventsStream.length > 0) {
    console.log(`Forwarding ${recordsForEventsStream.length} records to Events Firehose: ${EVENTS_FIREHOSE_NAME}`);
    const command = new PutRecordBatchCommand({
      DeliveryStreamName: EVENTS_FIREHOSE_NAME,
      Records: recordsForEventsStream,
    });
    s3ForwardPromises.push(
      firehoseClient.send(command).catch(err => console.error(`Error forwarding to Events Firehose:`, err))
      // TODO: Implement retry logic for failed records in the response if needed
    );
  }
  if (recordsForInitialEventsStream.length > 0) {
    console.log(`Forwarding ${recordsForInitialEventsStream.length} records to InitialEvents Firehose: ${INITIAL_EVENTS_FIREHOSE_NAME}`);
     const command = new PutRecordBatchCommand({
      DeliveryStreamName: INITIAL_EVENTS_FIREHOSE_NAME,
      Records: recordsForInitialEventsStream,
    });
    s3ForwardPromises.push(
      firehoseClient.send(command).catch(err => console.error(`Error forwarding to InitialEvents Firehose:`, err))
       // TODO: Implement retry logic
    );
  }

  // Wait for Aurora and S3 operations
  await Promise.all([...auroraInsertPromises, ...s3ForwardPromises]);
  console.log("Aurora inserts and S3 forwarding attempts complete.");

  // 6. Update Allowance
  const allowanceUpdatePromises: Promise<any>[] = [];
  for (const [siteId, decrementCount] of siteAllowanceDecrement.entries()) {
    if (decrementCount > 0) {
      console.log(`Decrementing allowance for site ${siteId} by ${decrementCount}`);
      allowanceUpdatePromises.push(
        db.update(sites)
          .set({ requestAllowance: sql`greatest(0, request_allowance - ${decrementCount})` }) // Use camelCase for set key
          .where(and(eq(sites.siteId, siteId), gte(sites.requestAllowance, 0))) // Ensure allowance isn't already negative
          .catch(err => console.error(`Error updating allowance for site ${siteId}:`, err))
      );
    }
  }

  await Promise.all(allowanceUpdatePromises);
  console.log("Allowance updates complete.");

  // 7. Return Value
  console.log("Processing complete. Returning results for each record.");
  return { records: results };
};