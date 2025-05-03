/*
The final table, used for building the various aggregations, is constructed by taking
{initial_events, events} from the HTTP response of /api/query, and merging them like so.
1. initial_events has all the properties from an initial page load. referer, utm_*, screen_height, session_id, etc.
1. events has only the subsequenty properties that are different. Eg pathname, properties, timestamp, session_id.

So intial_events has everything, and events are deltas. Then, the DB joins each session (a sequence of initial_events->evenst[]) via session_id, forward-filling (like df.ffill()) any missing properties from the first event (initial_events).
 */

import { create } from "zustand";
import * as duckdb from '@duckdb/duckdb-wasm';
import { type DateRange } from 'react-day-picker';
import { format } from 'date-fns';

// Import types
import {
  type AnalyticsStateBase, // Use relevant parts
  type AggregatedData,
  type Segment,
  type SankeyData,
  type AnalyticsStatus,
} from './analyticsTypes';

// Import functions from helper modules
import { initializeDb, cleanupDb } from './analyticsDb';
import { fetchData } from './analyticsApi'; // Only data fetching needed here
import { firstRow } from './analyticsUtils';
import {
  runAggregations as runAggregationsSql,
  runCustomPropertyAggregation as runCustomPropertyAggregationSql,
  runSankeyAggregation as runSankeyAggregationSql,
  generateCreateTableSQL,
  mapSchemaToDuckDBType
} from './analyticsSql';

// Import the HTTP store to subscribe to it
import { useHttpStore, type AnalyticsHttpState } from './analyticsHttpStore'; // Import state type

// Define the state structure for the SQL store
export interface AnalyticsSqlState extends Pick<AnalyticsStateBase,
  'status' | 'error' | 'aggregatedData' | 'selectedPropertyKey' |
  'sankeyData' | 'segments' // Removed isRefreshing
> {
  db: duckdb.AsyncDuckDB | null;
  connection: duckdb.AsyncDuckDBConnection | null;

  // Internal state to track last processed values
  lastProcessedSiteId: string | null;
  lastProcessedRange: DateRange | undefined;

  // Actions
  initialize: () => Promise<void>; // Renamed for clarity
  fetchAndLoadData: (siteId: string, range: DateRange) => Promise<void>; // Requires siteId/range
  runAggregations: () => Promise<void>;
  runCustomPropertyAggregation: (key: string) => Promise<void>;
  runSankeyAggregation: () => Promise<void>;
  addSegment: (segment: Segment) => void;
  removeSegment: (segmentToRemove: Segment) => void;
  clearSegments: () => void;
  cleanup: () => Promise<void>;
  resetSqlState: () => Partial<AnalyticsSqlState>; // Renamed for clarity
}

// Define the initial state for the SQL store
const initialSqlState: Pick<AnalyticsSqlState,
  'status' | 'error' | 'aggregatedData' | 'selectedPropertyKey' |
  'sankeyData' | 'segments' | 'db' | 'connection' | // Removed isRefreshing
  'lastProcessedSiteId' | 'lastProcessedRange'
> = {
  status: 'idle',
  error: null,
  aggregatedData: {
    stats: null, chartData: null, eventsData: null, sources: null, pages: null, regions: null, devices: null,
    customProperties: { availableKeys: [], aggregatedValues: null }
  },
  sankeyData: { nodes: [], links: [] },
  selectedPropertyKey: null,
  segments: [],
  // isRefreshing: false, // Removed
  db: null,
  connection: null,
  lastProcessedSiteId: null, // Initialize new state
  lastProcessedRange: undefined, // Initialize new state
};

// --- Zustand Store ---
export const useSqlStore = create<AnalyticsSqlState>()(
  (set, get) => ({
    ...initialSqlState,

    // --- Actions ---

    resetSqlState: () => {
      // Preserve DB/connection if they exist, reset data/status
      const currentStatus = get().status;
      const currentAggData = get().aggregatedData;
      const currentSelectedKey = get().selectedPropertyKey;
      // Reset data/segments/error etc., but keep DB/connection and last processed info
      return {
        status: ['loading_data', 'aggregating', 'initializing'].includes(currentStatus) ? currentStatus : 'idle',
        error: null,
        aggregatedData: { // Reset aggregated data
          stats: null, chartData: null, eventsData: null, sources: null, pages: null, regions: null, devices: null,
          customProperties: {
            availableKeys: currentAggData?.customProperties?.availableKeys || [],
            aggregatedValues: null
          }
        },
        sankeyData: { nodes: [], links: [] },
        segments: [], // Clear segments on reset
        selectedPropertyKey: null, // Reset key, runAggregations will handle selection
        // isRefreshing: false, // Removed
        // db: get().db, // Keep DB
        // connection: get().connection, // Keep Connection
      };
    },

    initialize: async () => {
      if (get().db) {
        console.log("SQL Store: DB already initialized.");
        return;
      }
      console.log("SQL Store: Initializing DB...");
      set({ status: 'initializing', error: null });
      try {
        const { db: newDb, connection: newConnection } = await initializeDb();
        set({ db: newDb, connection: newConnection, status: 'idle' });
        console.log("SQL Store: DB Initialized successfully.");
        // DO NOT trigger fetchAndLoadData here. The subscriber will handle it.
      } catch (initError: any) {
        console.error("SQL Store: DB Initialization failed:", initError);
        set({ status: 'error', error: initError.message || 'DB Initialization failed', db: null, connection: null });
      }
    },

    fetchAndLoadData: async (siteId: string, range: DateRange) => {
      console.log(`SQL Store: fetchAndLoadData called for site ${siteId}, range: ${range?.from ? format(range.from, 'P') : 'N/A'} - ${range?.to ? format(range.to, 'P') : 'N/A'}`);
      const { db, connection, status } = get(); // Removed isRefreshing

      // --- Pre-checks ---
      // Use status check instead of isRefreshing
      if (status === 'loading_data') {
          console.log("SQL Store: fetchAndLoadData skipped (already loading_data).");
          return;
      }
      if (!siteId || !range?.from || !range?.to) {
          console.log("SQL Store: fetchAndLoadData skipped (missing siteId or valid range).", { siteId, range });
          return;
      }
      if (!db || !connection) {
          console.error("SQL Store: fetchAndLoadData called but DB not initialized. This shouldn't happen.");
          set({ status: 'error', error: 'DB not initialized before data fetch attempt.' });
          return;
      }
      // Check only for initializing or aggregating, as loading_data is checked above
      if (status === 'initializing' || status === 'aggregating') {
        console.log(`SQL Store: Skipping fetchAndLoadData, current status: ${status}`);
        return;
      }

      console.log(`SQL Store: Starting data fetch & load process...`);
      set(state => ({
        // isRefreshing: true, // Removed
        status: 'loading_data',
        error: null, // Clear previous errors
        // Reset data, segments/key will be handled by runAggregations
        aggregatedData: initialSqlState.aggregatedData,
        sankeyData: initialSqlState.sankeyData,
        // Keep segments and selectedPropertyKey for now
        // segments: [], // Don't clear segments here, let runAggregations handle it based on current segments
        // selectedPropertyKey: null, // Keep key
      }));

      // Use a variable to track success for updating lastProcessed values
      let loadSuccessful = false;
      try {
        // Fetch data using imported API function
        const { initialEvents, events, commonSchema, initialOnlySchema } = await fetchData(siteId, range);

        // --- Register Data Buffers & Create View ---
        // Use fixed filenames and register buffers
        const initialEventsFileName = 'initial_events.json';
        const eventsFileName = 'events.json';
        const initialEventsBuffer = new TextEncoder().encode(JSON.stringify(initialEvents));
        const eventsBuffer = new TextEncoder().encode(JSON.stringify(events));
        await Promise.all([
          db.registerFileBuffer(initialEventsFileName, initialEventsBuffer),
          db.registerFileBuffer(eventsFileName, eventsBuffer)
        ]);
        console.log(`SQL Store: Registered ${initialEventsFileName} and ${eventsFileName}`);

        // Define schemas and SQL generation functions
        const fullInitialSchema = [...commonSchema, ...initialOnlySchema];
        const createInitialTableSql = generateCreateTableSQL('initial_events', fullInitialSchema);
        const createEventsTableSql = generateCreateTableSQL('events', commonSchema);

        const readInitialJsonColumnsSql = `{${fullInitialSchema.map(c => `"${c.name}": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`;
        const readEventsJsonColumnsSql = `{${commonSchema.map(c => `"${c.name}": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`;

        const insertInitialSql = `INSERT INTO initial_events SELECT * FROM read_json('${initialEventsFileName}', auto_detect=false, columns=${readInitialJsonColumnsSql});`;
        const insertEventsSql = `INSERT INTO events SELECT * FROM read_json('${eventsFileName}', auto_detect=false, columns=${readEventsJsonColumnsSql});`;

        // --- Define the Analytics View SQL ---
        const eventSpecificCols = ['event', 'pathname', 'timestamp', 'properties'];
        const staticCols = fullInitialSchema.filter(col => !eventSpecificCols.includes(col.name)).map(col => col.name);
        // Ensure session_id exists before partitioning by it
        const partitionKey = staticCols.includes('session_id') ? 'session_id' : (staticCols.length > 0 ? staticCols[0] : null); // Fallback if no session_id
        const staticColFirstValues = staticCols.map(col =>
          partitionKey
            ? `FIRST_VALUE(b."${col}") OVER (PARTITION BY b."${partitionKey}" ORDER BY b."timestamp") AS "${col}"`
            : `b."${col}"` // If no partition key, just select the column
        ).join(',\n                 ');

        const nullPlaceholders = initialOnlySchema.map(c => `NULL AS "${c.name}"`).join(', ');
        const commonSelectColsQuoted = commonSchema.map(c => `"${c.name}"`);
        const allColsSelectString = [...commonSelectColsQuoted, ...initialOnlySchema.map(c => `"${c.name}"`)].join(', ');

        // Note: Removed 'main.' prefix from table names
        const createAnalyticsViewSql = `
            CREATE VIEW analytics AS
            WITH base AS (
                SELECT ${allColsSelectString} FROM initial_events
                UNION ALL
                SELECT ${commonSelectColsQuoted.join(', ')}${initialOnlySchema.length > 0 ? ', ' + nullPlaceholders : ''} FROM events
            )
            SELECT b."event", b."pathname", b."timestamp", b."properties"${staticColFirstValues ? ', ' + staticColFirstValues : ''} FROM base b;
        `;

        // --- Execute SQL Transaction for Table Data ---
        await connection.query('BEGIN TRANSACTION;');
        let transactionSuccessful = false;
        try {
          // 1. Drop existing tables (view dropped separately later)
          await Promise.all([
            connection.query(`DROP TABLE IF EXISTS initial_events;`),
            connection.query(`DROP TABLE IF EXISTS events;`)
          ]);

          // 2. Create new tables
          await Promise.all([
              connection.query(createInitialTableSql),
              connection.query(createEventsTableSql)
          ]);

          // 3. Insert data into tables
          const insertPromises = [];
          if (initialEvents.length > 0) insertPromises.push(connection.query(insertInitialSql));
          if (events.length > 0) insertPromises.push(connection.query(insertEventsSql));
          if (insertPromises.length > 0) await Promise.all(insertPromises);

          // 4. Drop file buffers (no longer needed)
          await Promise.all([
            db.dropFile(initialEventsFileName),
            db.dropFile(eventsFileName)
          ]);
          console.log(`SQL Store: Dropped file buffers ${initialEventsFileName} and ${eventsFileName}`);

          // 5. Commit Transaction
          await connection.query('COMMIT;');
          transactionSuccessful = true;
          console.log('SQL Store: Table data transaction committed successfully.');

        } catch (txError) {
          console.error('SQL Store: Table data transaction failed, rolling back...', txError);
          await connection.query('ROLLBACK;');
          // Attempt to drop potentially lingering file buffers on error
          try {
            await Promise.all([
              db.dropFile(initialEventsFileName).catch(e => console.warn(`Failed to drop ${initialEventsFileName} during rollback:`, e)),
              db.dropFile(eventsFileName).catch(e => console.warn(`Failed to drop ${eventsFileName} during rollback:`, e))
            ]);
          } catch (dropError) {
             console.error('SQL Store: Error dropping files during rollback:', dropError);
          }
          throw txError; // Re-throw original error to be caught by outer catch
        }

        // --- Create the Analytics View (Post-Transaction) ---
        if (transactionSuccessful) {
          try {
              await connection.query(`DROP VIEW IF EXISTS analytics;`);
              await connection.query(createAnalyticsViewSql);
              const countResult = await connection.query(`SELECT COUNT(*) AS count FROM analytics`); // Verify view exists *now*
              console.log(`SQL Store: Analytics view created/recreated successfully with ${firstRow<{ count: number }>(countResult)?.count ?? 0} events.`);

              // Data loaded and view created successfully
              loadSuccessful = true; // Mark success
              set({ status: 'aggregating' }); // Move to aggregating state (isRefreshing removed)
              await get().runAggregations(); // Trigger aggregations
              // Status will be set to 'idle' by runAggregations on success

          } catch (viewError: any) {
              console.error('SQL Store: Failed to create analytics view after transaction:', viewError);
               // Set error state as view creation failed (isRefreshing removed)
               set({ error: `Failed to create analytics view: ${viewError?.message || String(viewError)}`, status: 'error' }); // Safer access
          }
        } else {
           // Should not happen if txError was thrown, but as a safeguard: (isRefreshing removed)
           console.error('SQL Store: Transaction was not successful, skipping view creation and aggregation.');
           set({ error: 'Data loading transaction failed.', status: 'error' });
        }

      } catch (err: any) {
        console.error("SQL Store: Failed to fetch, load, or merge analytics data:", err);
        // isRefreshing removed
        set({ error: err.message || 'An unknown error occurred during data loading', status: 'error' });
      }
    },

    runAggregations: async () => {
      const { connection, status, segments } = get();
      const selectedRange = useHttpStore.getState().selectedRange; // Get range from HTTP store

      // Allow running when status is 'aggregating', but guard against other busy/error states
      if (!connection || !selectedRange?.from || !selectedRange?.to || ['error', 'loading_data', 'initializing'].includes(status)) {
        console.log("SQL Store: Skipping aggregations - invalid state or range", { status, hasConnection: !!connection, selectedRange: !!selectedRange });
        return;
      }

      set({ status: 'aggregating', error: null });

      try {
        // Call the imported aggregation runner
        const newAggregatedData = await runAggregationsSql(connection, selectedRange, segments);

        set(state => ({
          aggregatedData: newAggregatedData,
          status: 'idle', // Set to idle *before* triggering dependent aggregations
          selectedPropertyKey: state.selectedPropertyKey // Preserve current selection temporarily
        }));

        // --- Parallelize dependent aggregations ---
        const aggregationPromises: Promise<void>[] = [];

        // 1. Sankey Aggregation
        aggregationPromises.push(get().runSankeyAggregation());

        // 2. Custom Property Aggregation
        const currentSelectedKey = get().selectedPropertyKey;
        const newlyFetchedKeys = newAggregatedData.customProperties?.availableKeys || [];
        let keyToAggregate: string | null = null;

        if (currentSelectedKey && newlyFetchedKeys.includes(currentSelectedKey)) {
          keyToAggregate = currentSelectedKey; // Keep current key if still valid
        } else if (newlyFetchedKeys.length > 0) {
          keyToAggregate = newlyFetchedKeys[0]; // Use first available if current is invalid or null
        }

        if (keyToAggregate) {
          aggregationPromises.push(get().runCustomPropertyAggregation(keyToAggregate));
        } else {
          // If no key to aggregate, ensure the state reflects that
          set(state => ({
            selectedPropertyKey: null,
            aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: null } } : null,
          }));
        }

        // Wait for both dependent aggregations to complete
        await Promise.all(aggregationPromises);
        // --- End Parallelization ---

      } catch (aggregationError: any) {
        console.error("SQL Store: Error during data aggregation orchestration:", aggregationError);
        // Ensure status is set back correctly on error
        set({ error: aggregationError.message || 'An error occurred during processing.', status: 'error', aggregatedData: null });
      }
    },

    runCustomPropertyAggregation: async (key: string) => {
      const { connection, aggregatedData, status, segments } = get();
      if (!connection || !key || !aggregatedData?.customProperties || ['aggregating', 'error', 'loading_data', 'initializing'].includes(status)) {
        console.warn("SQL Store: Skipping custom prop aggregation - invalid state or missing data.");
        return;
      }

      // Set the key being processed and clear old results
      set(state => ({
        selectedPropertyKey: key,
        aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: null } } : null,
      }));

      try {
        const results = await runCustomPropertyAggregationSql(connection, key, segments);
        set(state => ({
          aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: results } } : null,
        }));
      } catch (error: any) {
        console.error(`SQL Store: Error aggregating properties for key ${key}:`, error);
        set(state => ({
          error: error.message || `Error aggregating property '${key}'`, status: 'error', selectedPropertyKey: key,
          aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: [] } } : null,
        }));
      }
    },

    runSankeyAggregation: async () => {
      const { connection, status, segments } = get();
      if (!connection || ['aggregating', 'error', 'loading_data', 'initializing'].includes(status)) {
        console.log(`SQL Store: Skipping Sankey aggregation (status: ${status})`);
        return;
      }

      try {
        const sankeyData = await runSankeyAggregationSql(connection, segments);
        set({ sankeyData });
      } catch (sankeyError: any) {
        console.error("SQL Store: Error during Sankey data aggregation:", sankeyError);
        set({ error: sankeyError.message || 'Error during Sankey processing', status: 'error', sankeyData: null });
      }
    },

    // --- Segment Management ---
    addSegment: (segment: Segment) => {
      const currentSegments = get().segments;
      if (!currentSegments.some(s => s.type === segment.type && s.value === segment.value)) {
        console.log("SQL Store: Adding segment:", segment);
        set(state => ({ segments: [...state.segments, segment] }));
        get().runAggregations(); // Re-run aggregations with new segment
      } else {
        console.log("SQL Store: Segment already exists:", segment);
      }
    },
    removeSegment: (segmentToRemove: Segment) => {
      console.log("SQL Store: Removing segment:", segmentToRemove);
      set(state => ({ segments: state.segments.filter(s => !(s.type === segmentToRemove.type && s.value === segmentToRemove.value)) }));
      get().runAggregations(); // Re-run aggregations without segment
    },
    clearSegments: () => {
      console.log("SQL Store: Clearing all segments.");
      set({ segments: [] });
      get().runAggregations(); // Re-run aggregations with no segments
    },

    // --- Cleanup ---
    cleanup: async () => {
      const { connection, db } = get();
      console.log("SQL Store: Cleaning up DB connection.");
      await cleanupDb(db, connection); // Use imported function
      // Reset state explicitly after cleanup, don't spread initialSqlState here
      set({
        connection: null,
        db: null,
        status: 'idle',
        error: null,
        aggregatedData: initialSqlState.aggregatedData, // Reset data structures
        sankeyData: initialSqlState.sankeyData,
        selectedPropertyKey: null,
        segments: [],
        // isRefreshing: false, // Removed
      });
    },
  })
);

// --- Subscription to HTTP Store ---
// Run initial checks and subscribe after the store is created.
const initialState = useSqlStore.getState();
initialState.initialize(); // Attempt to initialize DB on load

useHttpStore.subscribe(
  // Listener reacts to changes in the HTTP store
  (httpState: AnalyticsHttpState /*, prevHttpState: AnalyticsHttpState */) => {
    const { selectedSiteId: currentSiteId, selectedRange: currentRange } = httpState;
    const sqlState = useSqlStore.getState();
    const {
      db, connection, status: sqlStatus,
      lastProcessedSiteId, lastProcessedRange
    } = sqlState;

    console.log("SQL Store: Subscriber notified by HTTP store change.", { currentSiteId, currentRange, sqlStatus });

    // --- Condition Checks ---

    // 1. Is DB ready?
    if (!db || !connection) {
      if (sqlStatus !== 'initializing' && sqlStatus !== 'error') {
        console.warn("SQL Store: Subscriber triggered but DB not ready and not initializing/error. State:", sqlStatus);
        // Optionally trigger initialize again if needed, but the initial call should handle it.
        // sqlState.initialize();
      } else {
        console.log("SQL Store: Subscriber waiting, DB status:", sqlStatus);
      }
      return; // Wait for DB initialization or error resolution
    }

    // 2. Is site selected?
    if (!currentSiteId) {
      console.log("SQL Store: No site selected in HTTP store. Clearing data.");
      // Clear data if site is deselected and wasn't already cleared
      if (lastProcessedSiteId !== null) {
        useSqlStore.setState({
          ...initialSqlState, // Reset most state
          db: sqlState.db, // Keep DB
          connection: sqlState.connection, // Keep Connection
          status: 'idle',
          error: 'No site selected.',
          lastProcessedSiteId: null, // Mark as processed null site
          lastProcessedRange: undefined, // Mark as processed null range
        });
      }
      return;
    }

    // 3. Is range valid?
    if (!currentRange?.from || !currentRange?.to) {
      console.log("SQL Store: Range is invalid in HTTP store. Waiting.");
      return; // Wait for a valid range
    }

    // 4. Has site or range actually changed from the last processed values?
    const siteChanged = currentSiteId !== lastProcessedSiteId;
    // Deep comparison for range object needed
    const rangeChanged = JSON.stringify(currentRange) !== JSON.stringify(lastProcessedRange);

    if (!siteChanged && !rangeChanged) {
      console.log("SQL Store: No change in site or range since last processing. Skipping.");
      return;
    }

    // 5. Is the SQL store busy?
    if (sqlStatus === 'loading_data' || sqlStatus === 'aggregating' || sqlStatus === 'initializing') {
      console.log(`SQL Store: Store is busy (${sqlStatus}). Deferring fetch.`);
      // Optionally, could set a flag to re-check later, but usually the next state change will trigger this again.
      return;
    }

    // --- Trigger Data Load ---
    console.log("SQL Store: Conditions met. Triggering fetchAndLoadData.", { currentSiteId, currentRange, siteChanged, rangeChanged });

    // Use async immediately to handle the promise from fetchAndLoadData
    (async () => {
       try {
           await sqlState.fetchAndLoadData(currentSiteId, currentRange);
           // If fetchAndLoadData completes without throwing, update last processed values
           // Check status again in case of errors within fetchAndLoadData that didn't throw but set status='error'
           const finalSqlState = useSqlStore.getState();
           if (finalSqlState.status !== 'error') {
               console.log("SQL Store: fetchAndLoadData completed successfully. Updating last processed values.");
               useSqlStore.setState({
                   lastProcessedSiteId: currentSiteId,
                   lastProcessedRange: currentRange,
               });
           } else {
                console.warn("SQL Store: fetchAndLoadData finished but ended in error state. Not updating last processed values.");
           }
       } catch (error) {
           // Error should have been handled and state set within fetchAndLoadData,
           // but log here just in case.
           console.error("SQL Store: Uncaught error during fetchAndLoadData triggered by subscriber:", error);
       }
    })();
  }
  // No selector argument provided
);