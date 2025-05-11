/**
 * This file should *only* handle data related to analytics, and only *after* it's been fetched. Eg:
 * 1. Managing the DuckDB
 * 1. Aggregating the data based on applied segments, filters, etc.
 * It should never fetch data from an HTTP endpoint, nor handle general site variables unrelated to analytics data management. See ./analyticsHttpStore for those.
 *
 * 1. /api/query fetches {initial_events, events}.
 * 1. initial_events are "fully hydrated" web analytics page-view events which include everything that can be known about a page_view (referer, screen_height, utm_*, etc)
 * 1. events are all subsequent events of the same session_id, and only include the "deltas": pathname, properties (eg if they click a button that has some property tag), etc.
 * 1. when the DuckDB is initialized, it joins a chain of initial_events & events by session_id as initial_events[0]->events[*]. It "hydrates" all events by filling in their missing properties from that session's initial_events, like `pandas.DataFrame.ffill()`.
 * 1. The goal of ffill is (1) so that the DuckDB table has the same number of columns for the merged initial_events & events (that's to say, the number of columns from initial_events, since that's the full picture); and (2) so that every event row has all the relevant properties to perform segmentation.
 */

import { create, type StateCreator } from "zustand"; // Import StateCreator as type
import { persist, createJSONStorage } from 'zustand/middleware';
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
  runAggregations as runAggregationsSql, // Base + initial tabs
  // Import specific aggregation routers
  runSourcesAggregationSql,
  runPagesAggregationSql,
  runRegionsAggregationSql,
  runDevicesAggregationSql,
  runEventsAggregationSql,
  // Other helpers
  runCustomPropertyAggregation as runCustomPropertyAggregationSql,
  runSankeyAggregation as runSankeyAggregationSql,
  // generateCreateTableSQL, // No longer needed directly in store
  // mapSchemaToDuckDBType, // No longer needed directly in store
  loadDataIntoTables, // New function for loading data
  createOrReplaceAnalyticsView // New function for view creation
} from './analyticsSql';
import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm"; // Import if not already

// Import the HTTP store to subscribe to it
import { useHttpStore, type AnalyticsHttpState } from './analyticsHttpStore'; // Import state type

// --- Refactored Aggregation Maps ---
// Define Maps outside the store for clarity and potential reuse
const aggregationExecutors = new Map<string, (conn: AsyncDuckDBConnection, seg: Segment[], view: string) => Promise<any>>([
  ['sources', runSourcesAggregationSql],
  ['pages', runPagesAggregationSql],
  ['regions', runRegionsAggregationSql],
  ['devices', runDevicesAggregationSql],
  ['events', runEventsAggregationSql],
]);

const aggregationStateUpdaters = new Map<string, (result: any) => Partial<AggregatedData>>([
  ['sources', (result) => ({ sources: result as AggregatedData['sources'] })],
  ['pages', (result) => ({ pages: result as AggregatedData['pages'] })],
  ['regions', (result) => ({ regions: result as AggregatedData['regions'] })],
  ['devices', (result) => ({ devices: result as AggregatedData['devices'] })],
  ['events', (result) => ({ eventsData: result as AggregatedData['eventsData'] })], // eventsData is top-level
]);
// --- End Refactored Aggregation Maps ---


// Define the state structure for the SQL store
export interface AnalyticsSqlState extends Pick<AnalyticsStateBase,
  'status' | 'error' | 'aggregatedData' | 'selectedPropertyKey' |
  'sankeyData' | 'segments' | // Removed isRefreshing
  'sourcesTab' | 'pagesTab' | 'regionsTab' | 'devicesTab' | 'eventsTab' // Added Tab State
> {
  db: duckdb.AsyncDuckDB | null;
  connection: duckdb.AsyncDuckDBConnection | null;

  // Actions
  initialize: () => Promise<void>; // Renamed for clarity
  lastFetchHash: string;
  fetchAndLoadData: () => Promise<void>; // Requires siteId/range
  runAggregations: () => Promise<void>; // Runs base + initial tabs
  runSpecificAggregation: (cardType: 'sources' | 'pages' | 'regions' | 'devices' | 'events', viewType: string) => Promise<void>; // Runs single tab aggregation
  runCustomPropertyAggregation: (key: string) => Promise<void>;
  runSankeyAggregation: () => Promise<void>;
  addSegment: (segment: Segment) => void;
  removeSegment: (segmentToRemove: Segment) => void;
  clearSegments: () => void;
  cleanup: () => Promise<void>;
  resetSqlState: () => Partial<AnalyticsSqlState>;
  // Tab Setters
  setSourcesTab: (tab: string) => Promise<void>;
  setPagesTab: (tab: string) => Promise<void>;
  setRegionsTab: (tab: string) => Promise<void>;
  setDevicesTab: (tab: string) => Promise<void>;
  setEventsTab: (tab: string) => Promise<void>;
  // Internal helper for rehydration
  _initializeNonPersistedState: () => void;

  // Internal helpers (not part of the public interface, but defined within create)
  // _setIdle: (partialState?: Partial<AnalyticsSqlState>) => void;
  // _setLoading: (status: 'initializing' | 'loading_data', partialState?: Partial<AnalyticsSqlState>) => void;
  // _setAggregating: (status: 'aggregating' | 'aggregating_tab', partialState?: Partial<AnalyticsSqlState>) => void;
  // _setError: (errorMessage: string, partialState?: Partial<AnalyticsSqlState>) => void;
}

// Define the initial state for the SQL store
const initialSqlState: Pick<AnalyticsSqlState,
  'status' | 'error' | 'aggregatedData' | 'selectedPropertyKey' |
  'sankeyData' | 'segments' | 'db' | 'connection' | // Removed isRefreshing
  'sourcesTab' | 'pagesTab' | 'regionsTab' | 'devicesTab' | 'eventsTab' |
  'lastFetchHash'
> = {
  status: 'idle',
  lastFetchHash: '',
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
  // Default Tab Values
  sourcesTab: 'channels',
  pagesTab: 'pages',
  regionsTab: 'countries', // Stays the same, matches httpStore
  devicesTab: 'browsers', // Change from 'devices' to 'browsers'
  eventsTab: 'events',
};

// --- Zustand Store ---
// Use StateCreator for better typing
const sqlStoreCreator: StateCreator<AnalyticsSqlState, [], [["zustand/persist", unknown]]> = (set, get) => {
  // --- Internal State Transition Helpers ---
  const _setIdle = (partialState: Partial<AnalyticsSqlState> = {}) => {
    set({ status: 'idle', error: null, ...partialState });
  };

  const _setLoading = (status: 'initializing' | 'loading_data', partialState: Partial<AnalyticsSqlState> = {}) => {
    set({ status, error: null, ...partialState });
  };

  const _setAggregating = (status: 'aggregating' | 'aggregating_tab', partialState: Partial<AnalyticsSqlState> = {}) => {
    set({ status, error: null, ...partialState });
  };

  const _setError = (errorMessage: string, partialState: Partial<AnalyticsSqlState> = {}) => {
    set({ status: 'error', error: errorMessage, ...partialState });
  };

  // Helper function to check if the store is in a busy state
  const _isBusy = (status: AnalyticsStatus): boolean => {
    return ['loading_data', 'aggregating', 'initializing', 'aggregating_tab'].includes(status);
  };
  // --- End Helpers ---

  // --- Internal Data Loading Helpers ---
  const _fetchApiData = async (siteId: string, rangeKey: string) => {
    console.log("SQL Store: Fetching data from API for rangeKey:", rangeKey);
    const rangeObject = useHttpStore.getState().getSelectedDateRangeObject();
    if (!rangeObject) {
      console.error("SQL Store: _fetchApiData could not get DateRange object for key:", rangeKey);
      throw new Error("Could not determine date range for fetching data.");
    }
    // This helper focuses solely on the API call. Error handling is done by the caller.
    return await fetchData(siteId, rangeObject);
  };

  const _loadTables = async (
    db: duckdb.AsyncDuckDB,
    connection: duckdb.AsyncDuckDBConnection,
    initialEvents: any[], // Consider using specific types if available
    events: any[],
    commonSchema: { name: string; type: string; }[], // Corrected type
    initialOnlySchema: { name: string; type: string; }[] // Corrected type
  ) => {
    console.log("SQL Store: Loading data into tables...");
    // This helper focuses on loading data. Error handling by caller.
    return await loadDataIntoTables(db, connection, initialEvents, events, commonSchema, initialOnlySchema);
  };

  const _createView = async (
    connection: duckdb.AsyncDuckDBConnection,
    commonSchema: { name: string; type: string; }[], // Corrected type
    initialOnlySchema: { name: string; type: string; }[] // Corrected type
  ) => {
    console.log("SQL Store: Creating or replacing analytics view...");
    // This helper focuses on view creation. Error handling by caller.
    await createOrReplaceAnalyticsView(connection, commonSchema, initialOnlySchema);
  };

  const _runInitialAggregations = async () => {
    console.log("SQL Store: Triggering initial aggregations...");
    _setAggregating('aggregating'); // Set status before calling
    // Error handling is within runAggregations itself
    await get().runAggregations();
  };
  // --- End Internal Data Loading Helpers ---

  return {
    ...initialSqlState,

    // --- Actions ---

    // Helper to reset non-persisted state during rehydration or manual reset
    _initializeNonPersistedState: () => {
      // Use _setIdle here? Or keep manual set for specific reset logic?
      // Let's keep manual set for now as it resets DB/connection too.
      set({
        status: 'idle',
        error: null,
        db: null, // DB needs re-initialization
        connection: null,
        aggregatedData: initialSqlState.aggregatedData, // Reset data
        sankeyData: initialSqlState.sankeyData,
        // Keep persisted state: tabs, selectedPropertyKey, segments
      });
      // Trigger DB initialization after resetting state
      // Use setTimeout to ensure state update completes before initialize potentially updates state again
      setTimeout(() => get().initialize(), 0);
    },

    resetSqlState: () => {
      // This resets parts of the state but keeps db/connection and status if busy.
      // It doesn't fit neatly into the simple helpers. Keep as is.
      const currentStatus = get().status;
      const currentAggData = get().aggregatedData;
      // Reset data/segments/error etc., but keep DB/connection
      return {
        status: _isBusy(currentStatus) ? currentStatus : 'idle',
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
        // db and connection are implicitly kept as they are not part of the returned partial state
      };
      },

    initialize: async () => {
      if (get().db) {
        console.log("SQL Store: DB already initialized.");
        return;
      }
      console.log("SQL Store: Initializing DB...");
      _setLoading('initializing'); // Use helper
      try {
        const { db: newDb, connection: newConnection } = await initializeDb();
        _setIdle({ db: newDb, connection: newConnection }); // Use helper
        console.log("SQL Store: DB Initialized successfully.");
        setTimeout(useSqlStore.getState().fetchAndLoadData, 0);
      } catch (initError: any) {
        console.error("SQL Store: DB Initialization failed:", initError);
        _setError(initError.message || 'DB Initialization failed', { db: null, connection: null }); // Use helper
      }
    },

    fetchAndLoadData: async () => {
      const { db, connection, status, lastFetchHash } = get();
      // --- Pre-checks (Remain the same) ---
      if (status === 'loading_data') {
          console.log("SQL Store: fetchAndLoadData skipped (already loading_data).");
          return;
      }
      if (!db || !connection) {
          console.log("SQL Store: fetchAndLoadData called but DB not initialized.");
          // _setError('DB not initialized before data fetch attempt.');
          return;
      }
      if (status === 'initializing' || status === 'aggregating' || status === 'aggregating_tab') {
        console.log(`SQL Store: Skipping fetchAndLoadData, current status: ${status}`);
        return;
      }
      const { selectedSiteId: siteId, selectedRangeKey, getSelectedDateRangeObject } = useHttpStore.getState();
      const rangeObject = getSelectedDateRangeObject();

      if (!siteId || !selectedRangeKey || !rangeObject?.from || !rangeObject?.to) {
          console.log("SQL Store: fetchAndLoadData skipped (missing siteId, rangeKey or valid rangeObject).", { siteId, selectedRangeKey, rangeObject });
          return;
      }
      // skip if the same siteId & rangeKey are selected as last time
      console.log(`SQL Store: fetchAndLoadData called for site ${siteId}, rangeKey: ${selectedRangeKey}, range: ${rangeObject.from ? format(rangeObject.from, 'P') : 'N/A'} - ${rangeObject.to ? format(rangeObject.to, 'P') : 'N/A'}`);
      const currFetchHash = `${siteId}|${selectedRangeKey}` // Use rangeKey for hash
      if (currFetchHash === lastFetchHash) {
        return console.log("SQL Store: fetchAndLoadData already called for this siteId & rangeKey combo")
      }
      set({lastFetchHash: currFetchHash})

      console.log(`SQL Store: Starting data fetch & load process...`);
      _setLoading('loading_data', {
        aggregatedData: initialSqlState.aggregatedData,
        sankeyData: initialSqlState.sankeyData,
      });

      try {
        // Step 1: Fetch data from API
        const { initialEvents, events, commonSchema, initialOnlySchema } = await _fetchApiData(siteId, selectedRangeKey);

        // This code goes into fetchAndLoadData in analyticsSqlStore.ts
        // Ensure 'initialEvents' is the correct variable name for the array of initial event objects.
    
        // Remove any prior modifications to event.source or event.referrer here.
    
        for (const event of initialEvents) { // Assuming 'initialEvents' is the array from _fetchApiData
          if (event.utm_source && typeof event.utm_source === 'string' && event.utm_source.trim() !== '') {
            event.referer_domain = event.utm_source; // This assigns utm_source to the field that becomes the SQL referer_domain
          }
        }

        // Step 2: Load data into tables
        const tablesLoaded = await _loadTables(db, connection, initialEvents, events, commonSchema, initialOnlySchema);

        if (!tablesLoaded) {
          // If loading fails, set error and exit early
          console.error('SQL Store: Table loading was not successful, skipping view creation and aggregation.');
          if (get().status !== 'error') { // Avoid overwriting specific fetch/load error
             _setError('Data loading into tables failed.');
          }
          return; // Stop processing
        }

        // Step 3: Create the analytics view
        await _createView(connection, commonSchema, initialOnlySchema);

        // Step 4: Trigger initial aggregations (this will set status to 'aggregating' and then 'idle' on success)
        await _runInitialAggregations();

      } catch (err: any) {
        // Catch errors from any step (_fetchApiData, _loadTables, _createView)
        console.error("SQL Store: Error during fetch/load/view process:", err);
        _setError(err.message || 'An unknown error occurred during data processing');
        // Note: _runInitialAggregations handles its own errors internally and sets status appropriately.
      }
      },
      
      runAggregations: async () => {
      const { connection, status, segments } = get();
      // Get tab states from HTTP store for runAggregationsSql
      // At the top of runAggregations, get all relevant tabs from HttpStore
      const { sourcesCardTab, pagesCardTab, eventsCardTab, regionsCardTab, devicesCardTab, getSelectedDateRangeObject } = useHttpStore.getState();

      const rangeObject = getSelectedDateRangeObject();

      // Allow running when status is 'aggregating', but guard against other busy/error states
      // Use _isBusy helper, but exclude 'aggregating' itself from the check here
      const isBusyForInitialAgg = status === 'loading_data' || status === 'initializing' || status === 'aggregating_tab';
      if (!connection || !rangeObject?.from || !rangeObject?.to || status === 'error' || isBusyForInitialAgg) {
        console.log("SQL Store: Skipping initial aggregations - invalid state or range", { status, hasConnection: !!connection, rangeObject });
        // If called while aggregating_tab, it might mean a race condition, let the tab finish.
        return;
      }

      // If status is already 'aggregating', don't reset error (it should be null anyway)
      if (status !== 'aggregating') {
        _setAggregating('aggregating'); // Use helper
      }

      try {
        // Define the views based on current tab state
        const initialViews = {
          sourcesView: sourcesCardTab,
          pagesView: pagesCardTab,
          regionsView: regionsCardTab, // Use from HttpStore
          devicesView: devicesCardTab, // Use from HttpStore
          eventsView: eventsCardTab,
        };

        // Call the refactored aggregation runner with initial views and rangeObject
        const initialAggregatedData = await runAggregationsSql(connection, rangeObject, segments, initialViews);

        // Update state with the partial data (base + initial tabs)
        // Use functional set to merge safely, ensuring undefined from partial becomes null
        // State merging logic seems okay, keep using functional set for complex merge
        let finalAggData: AggregatedData | null = null;
        set(state => {
          // Define a guaranteed non-null default based on initial state, explicitly casting
          const defaultAggData = initialSqlState.aggregatedData as AggregatedData;
          // Use the current state's data if available, otherwise the default
          const currentAggData = state.aggregatedData || defaultAggData;

          const newAggData: AggregatedData = {
            // Fallback chain: New data -> Current data -> Default data -> null (Default should prevent null here)
            stats: initialAggregatedData.stats ?? currentAggData.stats ?? defaultAggData.stats,
            chartData: initialAggregatedData.chartData ?? currentAggData.chartData ?? defaultAggData.chartData,
            eventsData: initialAggregatedData.eventsData ?? currentAggData.eventsData ?? defaultAggData.eventsData,
            sources: initialAggregatedData.sources ?? currentAggData.sources ?? defaultAggData.sources,
            pages: initialAggregatedData.pages ?? currentAggData.pages ?? defaultAggData.pages,
            regions: initialAggregatedData.regions ?? currentAggData.regions ?? defaultAggData.regions,
            devices: initialAggregatedData.devices ?? currentAggData.devices ?? defaultAggData.devices,
            customProperties: {
              // Fallback chain: New -> Current -> Default -> Explicit Default []
              availableKeys: initialAggregatedData.customProperties?.availableKeys ?? currentAggData.customProperties?.availableKeys ?? defaultAggData.customProperties?.availableKeys ?? [],
              // Fallback chain: Current -> Default -> Explicit Default null
              aggregatedValues: currentAggData.customProperties?.aggregatedValues ?? defaultAggData.customProperties?.aggregatedValues ?? null,
            }
          };
          finalAggData = newAggData; // Capture for dependent aggregations
          return {
            aggregatedData: newAggData,
            // Status will be set to idle *after* dependent aggregations complete
            // selectedPropertyKey: state.selectedPropertyKey // Preserve current selection temporarily - handled below
          };
        });


        // --- Parallelize dependent aggregations (Sankey and Custom Property) ---
        const aggregationPromises: Promise<void>[] = [];

        // 1. Sankey Aggregation (remains the same)
        aggregationPromises.push(get().runSankeyAggregation()); // No status change needed inside

        // 2. Custom Property Aggregation (logic remains the same, uses updated availableKeys)
        const currentSelectedKey = get().selectedPropertyKey;
        // Get the updated keys *after* the set call above
        const newlyFetchedKeys = get().aggregatedData?.customProperties?.availableKeys || [];
        let keyToAggregate: string | null = null;

        if (currentSelectedKey && newlyFetchedKeys.includes(currentSelectedKey)) {
          keyToAggregate = currentSelectedKey;
        } else if (newlyFetchedKeys.length > 0) {
          keyToAggregate = newlyFetchedKeys[0];
        }

        if (keyToAggregate) {
          // Trigger the aggregation, which will update selectedPropertyKey and aggregatedValues
          aggregationPromises.push(get().runCustomPropertyAggregation(keyToAggregate)); // No status change needed inside
        } else {
          // If no key to aggregate, ensure the state reflects that
          set(state => ({
            selectedPropertyKey: null,
            aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: null } } : null,
          }));
        }

        // Wait for both dependent aggregations to complete
        await Promise.all(aggregationPromises);
        _setIdle(); // Set status to idle *after* all aggregations succeed
        // --- End Parallelization ---

      } catch (aggregationError: any) {
        console.error("SQL Store: Error during initial data aggregation orchestration:", aggregationError);
        // Ensure status is set back correctly on error
        _setError(aggregationError.message || 'An error occurred during processing', { aggregatedData: null }); // Use helper
      }
    },

    runCustomPropertyAggregation: async (key: string) => {
      const { connection, aggregatedData, status, segments } = get();
      // Allow running even if status is 'idle' (triggered after main aggregation)
      if (!connection || !key || !aggregatedData?.customProperties || ['error', 'loading_data', 'initializing'].includes(status)) {
        console.warn("SQL Store: Skipping custom prop aggregation - invalid state or missing data.");
        return;
      }

      // Set the key being processed and clear old results
      // Set key, clear results, but don't change main status
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
        // Set error, but keep the selected key. Don't change main status here, let the caller handle it.
        set(state => ({
          error: error.message || `Error aggregating property '${key}'`,
          // status: 'error', // Don't set main status to error here
          selectedPropertyKey: key,
          aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: [] } } : null,
        }));
        // Re-throw the error so Promise.all in runAggregations catches it
        throw error;
      }
    },

    runSankeyAggregation: async () => {
      const { connection, status, segments } = get();
      // Allow running even if status is 'idle'
      if (!connection || ['error', 'loading_data', 'initializing'].includes(status)) {
        console.log(`SQL Store: Skipping Sankey aggregation (status: ${status})`);
        return;
      }

      try {
        const sankeyData = await runSankeyAggregationSql(connection, segments);
        set({ sankeyData }); // Simple update, no status change needed
      } catch (sankeyError: any) {
        console.error("SQL Store: Error during Sankey data aggregation:", sankeyError);
        // Set error, but don't change main status here. Let the caller handle it.
        set({ error: sankeyError.message || 'Error during Sankey processing', sankeyData: null });
        // Re-throw the error so Promise.all in runAggregations catches it
        throw sankeyError;
      }
    },

    // --- Specific Aggregation Runner (for Tab Changes) ---
    runSpecificAggregation: async (cardType, viewType) => {
      const { connection, db, segments, status } = get();

      if (!db || !connection) {
        console.warn(`SQL Store: Skipping specific aggregation for ${cardType}/${viewType} - DB not ready.`);
        return;
      }
      // Prevent running if already busy with a major load/aggregation or another tab
      if (_isBusy(status)) { // Use helper
         console.log(`SQL Store: Skipping specific aggregation for ${cardType}/${viewType} - store busy (${status}).`);
         return;
      }

      console.log(`SQL Store: Running specific aggregation for ${cardType}, view: ${viewType}`);
      _setAggregating('aggregating_tab'); // Use helper

      try {
        // --- Refactored: Use Map lookup for execution ---
        const executor = aggregationExecutors.get(cardType);
        if (!executor) {
          // console.error(`SQL Store: Unknown cardType for specific aggregation: ${cardType}`);
          throw new Error(`Unknown cardType: ${cardType}`);
        }
        const result = await executor(connection, segments, viewType);
        // --- End Refactor ---

        // Update only the relevant part of aggregatedData using a type-safe approach
        // State merging logic seems okay, keep using functional set
        set(state => {
          const currentAggData = state.aggregatedData || initialSqlState.aggregatedData as AggregatedData;

          // --- Refactored: Use Map lookup for state update ---
          const stateUpdater = aggregationStateUpdaters.get(cardType);
          if (!stateUpdater) {
            // This should ideally not happen if the executor map is synced, but good practice to check
            console.error(`SQL Store: Unknown cardType for state update: ${cardType}`);
            // Potentially throw or handle gracefully
             // Throw error to be caught below
             throw new Error(`Internal error: Unknown cardType ${cardType} for state update`);
          }
          const updatedSlice = stateUpdater(result);
          // --- End Refactor ---

          // Merge the updated slice into the existing aggregatedData
          const finalAggData = {
            ...currentAggData,
            ...updatedSlice,
          };

          return {
            aggregatedData: finalAggData,
            // status: 'idle' // Status reset in finally block - handled below
          };
        });
        _setIdle(); // Set idle on success

      } catch (error: any) {
        console.error(`SQL Store: Error during specific aggregation for ${cardType}/${viewType}:`, error);
        _setError(error.message || `Error aggregating ${cardType} tab`); // Use helper
      }
      // No finally block needed as _setIdle/_setError handle status updates
    },

    // --- Segment Management ---
    // No status changes needed here, they trigger runAggregations which handles status
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
      // Use _setIdle and explicitly reset data structures
      _setIdle({
        connection: null,
        db: null,
        aggregatedData: initialSqlState.aggregatedData, // Reset data structures
        sankeyData: initialSqlState.sankeyData,
        selectedPropertyKey: null,
        segments: [],
        // isRefreshing: false, // Removed
      });
    },

    // --- Tab Setters (Now trigger specific aggregation) ---
    // These now just set the tab state and call runSpecificAggregation, which handles status
    setSourcesTab: async (tab: string) => {
      const currentAggData = get().aggregatedData;
      set({ sourcesTab: tab }); // Set the tab state first

      // Only run aggregation if comprehensive data for 'sources' isn't already loaded
      if (!currentAggData?.sources) {
        console.log("SQL Store: setSourcesTab - Sources data not yet loaded, running specific aggregation.");
        await get().runSpecificAggregation('sources', tab);
      } else {
        console.log("SQL Store: setSourcesTab - Sources data already present, only updating tab state.");
      }
    },
    setPagesTab: async (tab: string) => {
      const currentAggData = get().aggregatedData;
      set({ pagesTab: tab }); // Set the tab state first

      // Only run aggregation if comprehensive data for 'pages' isn't already loaded
      if (!currentAggData?.pages) {
        console.log("SQL Store: setPagesTab - Pages data not yet loaded, running specific aggregation.");
        await get().runSpecificAggregation('pages', tab);
      } else {
        console.log("SQL Store: setPagesTab - Pages data already present, only updating tab state.");
      }
    },
    setRegionsTab: async (tab: string) => {
      // For Regions and Devices, the original fix in analyticsSql.ts already made them fetch all data.
      // We apply the same optimization here to prevent re-aggregation if data is present.
      const currentAggData = get().aggregatedData;
      set({ regionsTab: tab });
      if (!currentAggData?.regions) {
        console.log("SQL Store: setRegionsTab - Regions data not yet loaded, running specific aggregation.");
        await get().runSpecificAggregation('regions', tab);
      } else {
        console.log("SQL Store: setRegionsTab - Regions data already present, only updating tab state.");
      }
    },
    setDevicesTab: async (tab: string) => {
      const currentAggData = get().aggregatedData;
      set({ devicesTab: tab });
      if (!currentAggData?.devices) {
        console.log("SQL Store: setDevicesTab - Devices data not yet loaded, running specific aggregation.");
        await get().runSpecificAggregation('devices', tab);
      } else {
        console.log("SQL Store: setDevicesTab - Devices data already present, only updating tab state.");
      }
    },
    setEventsTab: async (tab: string) => {
      const currentAggData = get().aggregatedData;
      set({ eventsTab: tab }); // Set the tab state first

      // Only run aggregation if eventsData isn't already loaded
      if (!currentAggData?.eventsData) {
        console.log("SQL Store: setEventsTab - Events data not yet loaded, running specific aggregation.");
        await get().runSpecificAggregation('events', tab);
      } else {
        console.log("SQL Store: setEventsTab - Events data already present, only updating tab state.");
      }
    },

  }; // End of return object
}; // End of sqlStoreCreator

export const useSqlStore = create<AnalyticsSqlState>()(
  persist(
    sqlStoreCreator, // Pass the creator function
    // --- Persist Configuration ---
    {
      name: 'analytics-sql-preferences', // Unique name for this store's persistence
      storage: createJSONStorage(() => localStorage),
      partialize: (state): Partial<AnalyticsSqlState> => ({
        // Persist only the selected custom property key
        // Tab states are now persisted in analyticsHttpStore
        selectedPropertyKey: state.selectedPropertyKey,
        // Do not persist: status, error, db, connection, aggregatedData, sankeyData, segments, lastProcessed*, tab states
      }),
      onRehydrateStorage: () => (state, error) => {
        console.log("SQL Store: Rehydrating state (selectedPropertyKey only)...");
        if (error) {
          console.error("SQL Store: Failed to rehydrate state:", error);
          state?._initializeNonPersistedState();
          return;
        }
        if (!state) {
          console.warn("SQL Store: State is undefined during rehydration.");
          useSqlStore.getState()._initializeNonPersistedState();
          return;
        }

        // Only selectedPropertyKey is rehydrated here.
        // Tab defaults are set in initialSqlState and will be overridden by httpStore subscription.
        console.log("SQL Store: Rehydration complete. Initializing non-persisted state.");
        state._initializeNonPersistedState();
      }
    }
  ) // End persist wrapper
);

// Subscribe to selectedSiteId and selectedRangeKey from HttpStore for data fetching
useHttpStore.subscribe(
  (state) => ({ siteId: state.selectedSiteId, rangeKey: state.selectedRangeKey }),
  (currentHttpSelection, previousHttpSelection) => {
    console.log("SQL Store: HttpStore siteId/rangeKey subscriber triggered.", currentHttpSelection);
    const { status, fetchAndLoadData, resetSqlState } = useSqlStore.getState();
    const { selectedSiteId } = useHttpStore.getState(); // Get current siteId

    if (!selectedSiteId) {
      console.log("SQL Store: No site selected in HttpStore, resetting SQL state.");
      resetSqlState(); // Reset data if no site is selected
      // Potentially clear DB connection as well if desired, or keep it for faster next load
      return;
    }

    // Fetch data if siteId or rangeKey has actually changed and store is idle
    // This check prevents fetching if only other httpStore state changed
    if (
      (currentHttpSelection.siteId !== previousHttpSelection.siteId ||
       currentHttpSelection.rangeKey !== previousHttpSelection.rangeKey) &&
      status !== "loading_data" && status !== "initializing" // Allow fetch if idle or error
    ) {
      console.log("SQL Store: SiteId or RangeKey changed, calling fetchAndLoadData.");
      fetchAndLoadData();
    } else if (status !== "idle" && status !== "error" && status !== "loading_data" && status !== "initializing") {
      console.log(`SQL Store: HttpStore change detected but SQL store is busy (${status}) or no relevant change.`);
    } else if (!currentHttpSelection.siteId && (previousHttpSelection.siteId)) {
        // If siteId became null (e.g. user logs out or all sites deleted)
        console.log("SQL Store: SiteId became null, resetting SQL store.");
        resetSqlState();
    }
  },
  { equalityFn: (a, b) => a.siteId === b.siteId && a.rangeKey === b.rangeKey, fireImmediately: true }
);


// Subscribe to individual tab changes in HttpStore
const httpStoreUnsubscribers = [
  useHttpStore.subscribe(
    state => state.sourcesCardTab,
    newHttpSourcesCardTab => {
      console.log("SQL Store: sourcesCardTab changed in HttpStore:", newHttpSourcesCardTab);
      const { sourcesTab, setSourcesTab } = useSqlStore.getState();
      if (newHttpSourcesCardTab !== sourcesTab) {
        setSqlStore(state => ({ ...state, sourcesTab: newHttpSourcesCardTab })); // Update internal tab
        useSqlStore.getState().runSpecificAggregation('sources', newHttpSourcesCardTab);
      }
    }
  ),
  useHttpStore.subscribe(
    state => state.pagesCardTab,
    newHttpPagesCardTab => {
      console.log("SQL Store: pagesCardTab changed in HttpStore:", newHttpPagesCardTab);
      const { pagesTab, setPagesTab } = useSqlStore.getState();
      if (newHttpPagesCardTab !== pagesTab) {
        setSqlStore(state => ({ ...state, pagesTab: newHttpPagesCardTab })); // Update internal tab
        useSqlStore.getState().runSpecificAggregation('pages', newHttpPagesCardTab);
      }
    }
  ),
  useHttpStore.subscribe(
    state => state.eventsCardTab,
    newHttpEventsCardTab => {
      console.log("SQL Store: eventsCardTab changed in HttpStore:", newHttpEventsCardTab);
      const { eventsTab, setEventsTab } = useSqlStore.getState();
      if (newHttpEventsCardTab !== eventsTab) {
        setSqlStore(state => ({ ...state, eventsTab: newHttpEventsCardTab })); // Update internal tab
        useSqlStore.getState().runSpecificAggregation('events', newHttpEventsCardTab);
      }
    }
  )
];

// Helper to set state in sqlStore, as `set` is not directly available outside creator
const setSqlStore = (fn: (state: AnalyticsSqlState) => Partial<AnalyticsSqlState>) => {
  useSqlStore.setState(fn);
};

// TODO: Consider unsubscribing when the store is destroyed if that's a pattern used elsewhere.
// For now, these subscriptions will live as long as the app.
