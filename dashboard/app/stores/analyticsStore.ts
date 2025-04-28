import { create } from "zustand";
import { persist, createJSONStorage } from 'zustand/middleware';
import * as duckdb from '@duckdb/duckdb-wasm';
import { type DateRange } from 'react-day-picker';
import { subDays, format, startOfDay, endOfDay, isValid, parseISO } from 'date-fns';

// Import types from the new types module
import {
    type AnalyticsStateBase,
    type AggregatedData,
    type Segment,
    type SankeyData,
    type AnalyticsStatus,
    type Site, // Re-exported from analyticsTypes
    type UserPreferences // Re-exported from analyticsTypes
} from './analyticsTypes';

// Import functions from the new modules
import { initializeDb, cleanupDb } from './analyticsDb';
import { fetchData, fetchSitesAndPreferences } from './analyticsApi';
import { firstRow } from './analyticsUtils'; // Only need firstRow here, others used within analyticsSql
import {
    runAggregations as runAggregationsSql,
    runCustomPropertyAggregation as runCustomPropertyAggregationSql,
    runSankeyAggregation as runSankeyAggregationSql,
    generateCreateTableSQL, // Needed for view creation orchestration
    mapSchemaToDuckDBType   // Needed for view creation orchestration
} from './analyticsSql';

// Define the initial state structure for resetting
// Aligns with AnalyticsStateBase
const initialAnalyticsState: AnalyticsStateBase = {
    status: 'idle',
    error: null,
    selectedPropertyKey: null,
    segments: [],
    sourcesTab: 'channels',
    pagesTab: 'topPages',
    regionsTab: 'countries',
    devicesTab: 'browsers',
    eventsTab: 'events',
    selectedRange: { // Default to last 7 days
        from: subDays(startOfDay(new Date()), 6),
        to: endOfDay(new Date()),
    } as DateRange | undefined,
    aggregatedData: {
        stats: null, chartData: null, eventsData: null, sources: null, pages: null, regions: null, devices: null,
        customProperties: { availableKeys: [], aggregatedValues: null }
    },
    sankeyData: { nodes: [], links: [] },
    sites: [] as Site[],
    selectedSiteId: null as string | null,
    userPreferences: null as UserPreferences | null,
    isRefreshing: false,
};

// Define the full state interface including DB handles and actions
export interface AnalyticsState extends AnalyticsStateBase {
   db: duckdb.AsyncDuckDB | null;
    connection: duckdb.AsyncDuckDBConnection | null;

    // Actions
    resetAnalyticsState: () => Partial<AnalyticsState>;
    setSelectedRange: (range: DateRange | undefined) => void;
    fetchSites: () => Promise<void>;
    setSelectedSiteId: (siteId: string | null) => void;
    fetchAndLoadData: () => Promise<void>;
    runAggregations: () => Promise<void>; // This will orchestrate calls to analyticsSql
    runCustomPropertyAggregation: (key: string) => Promise<void>; // This will orchestrate calls to analyticsSql
    runSankeyAggregation: () => Promise<void>; // This will orchestrate calls to analyticsSql
    cleanup: () => Promise<void>;
    setSourcesTab: (tab: string) => void;
    setPagesTab: (tab: string) => void;
    setRegionsTab: (tab: string) => void;
    setDevicesTab: (tab: string) => void;
    setEventsTab: (tab: string) => void;
    addSegment: (segment: Segment) => void;
    removeSegment: (segmentToRemove: Segment) => void;
    clearSegments: () => void;
}

// --- Zustand Store ---
export const useStore = create<AnalyticsState>()(
    persist(
        (set, get) => ({
            db: null,
            connection: null,
            ...initialAnalyticsState, // Spread the initial state

            // --- Core State Actions ---

            resetAnalyticsState: () => {
                const currentStatus = get().status;
                const currentAggData = get().aggregatedData;
                const currentSelectedKey = get().selectedPropertyKey;
                // Return only the fields that need resetting, preserving others
                return {
                    status: ['loading_data', 'aggregating'].includes(currentStatus) ? currentStatus : 'idle',
                    error: null,
                    aggregatedData: {
                        stats: null, chartData: null, eventsData: null, sources: null, pages: null, regions: null, devices: null,
                        customProperties: {
                            availableKeys: currentAggData?.customProperties?.availableKeys || [],
                            aggregatedValues: null
                        }
                    },
                    sankeyData: { nodes: [], links: [] },
                    segments: [],
                    selectedPropertyKey: currentSelectedKey, // Keep key temporarily, runCustomPropertyAggregation will validate
                    // Keep sites, selectedSiteId, selectedRange, userPreferences
                    sites: get().sites,
                    selectedSiteId: get().selectedSiteId,
                    selectedRange: get().selectedRange,
                    userPreferences: get().userPreferences,
                };
            },

            setSelectedRange: (range: DateRange | undefined) => {
                if (JSON.stringify(range) === JSON.stringify(get().selectedRange)) return;
                 set(state => ({
                     selectedRange: range,
                     ...state.resetAnalyticsState(), // Reset analytics, keep range
                     segments: [] // Clear segments when range changes
                 }));
                 get().fetchAndLoadData(); // Fetch data for the new range
            },

            setSelectedSiteId: (siteId: string | null) => {
                if (siteId === get().selectedSiteId) return;
                console.log(`Setting selected site ID to: ${siteId}`);
                set(state => ({
                    selectedSiteId: siteId,
                    ...state.resetAnalyticsState(), // Reset analytics data, keep site selection
                    segments: [] // Clear segments when site changes
                 }));
                 if (siteId) {
                    get().fetchAndLoadData(); // Fetch data for the new site
                 } else {
                    set({ aggregatedData: null, status: 'idle', error: 'Please select a site.' });
                 }
            },

            // --- Data Fetching and Loading Orchestration ---

            fetchSites: async () => {
                console.log("AnalyticsStore: fetchSites called.");
                try {
                    const { sites: fetchedSites, preferences: fetchedPreferences } = await fetchSitesAndPreferences(); // Use imported function

                    set(state => {
                        const currentSelectedId = state.selectedSiteId;
                        // Auto-select first site if none selected or previous selection invalid
                        const newSelectedSiteId = (!currentSelectedId || !fetchedSites.some(s => s.site_id === currentSelectedId)) && fetchedSites.length > 0
                            ? fetchedSites[0].site_id
                            : currentSelectedId;

                        return {
                            sites: fetchedSites,
                            userPreferences: fetchedPreferences,
                            selectedSiteId: newSelectedSiteId,
                            status: newSelectedSiteId ? state.status : 'idle', // Keep status if site selected
                            error: null
                        };
                    });

                    // Trigger data load only if a site is now selected
                    if (get().selectedSiteId) {
                        get().fetchAndLoadData();
                    } else if (fetchedSites.length === 0) {
                         set({ status: 'idle', error: 'No sites found for this user.', aggregatedData: null });
                    }
                } catch (err: any) {
                    console.error("Failed to fetch sites or preferences in store:", err);
                    set({ status: 'error', error: err.message, sites: [], userPreferences: null, selectedSiteId: null, aggregatedData: null });
                }
            },

            fetchAndLoadData: async () => {
                console.log("AnalyticsStore: fetchAndLoadData called.");
                if (get().isRefreshing) {
                    console.log("AnalyticsStore: fetchAndLoadData skipped (already refreshing).");
                    return;
                }

                const { status, selectedSiteId, db, selectedRange } = get();

                // Initialize DB if needed (calls imported function)
                if (!db) {
                    console.log("DB not initialized, initializing...");
                    set({ status: 'initializing' });
                    try {
                        const { db: newDb, connection: newConnection } = await initializeDb(); // Use imported function
                        set({ db: newDb, connection: newConnection });
                        // After DB init, fetch sites which might trigger this function again
                        await get().fetchSites();
                        return; // Exit, let the next call handle data fetching
                    } catch (initError: any) {
                        console.error("Initialization failed:", initError);
                        set({ status: 'error', error: initError.message || 'Initialization failed', isRefreshing: false });
                        return;
                    }
                }

                // Guard: Wait if no site or range selected
                if (!selectedSiteId) {
                    console.log("No site selected, waiting.");
                    // If sites haven't been loaded yet, try fetching them
                    if (get().sites.length === 0 && status !== 'error') {
                        await get().fetchSites();
                    } else if (get().sites.length === 0 && status === 'idle') {
                         set({ status: 'idle', error: 'No sites found. Please create a site first.' });
                    }
                    return;
                }
                if (!selectedRange?.from || !selectedRange?.to) {
                    console.log("Date range not fully selected, skipping data fetch.");
                    return;
                }

                // Guard: Don't run if already busy
                if (status === 'loading_data' || status === 'initializing' || status === 'aggregating') return;

                console.log(`Fetching data for site ${selectedSiteId}, range: ${format(selectedRange.from, 'P')} - ${format(selectedRange.to, 'P')}`);
                set(state => ({
                    isRefreshing: true,
                    status: 'loading_data',
                    ...state.resetAnalyticsState(), // Reset data/segments/error etc.
                    // Keep necessary state through reset
                    sites: state.sites,
                    selectedSiteId: state.selectedSiteId,
                    selectedRange: state.selectedRange,
                    userPreferences: state.userPreferences,
                }));

                try {
                    // Fetch data using imported API function
                    const { initialEvents, events, commonSchema, initialOnlySchema } = await fetchData(selectedSiteId, selectedRange);

                    const { db: currentDb, connection } = get(); // Get current DB handles
                    if (!currentDb || !connection) throw new Error("Database connection lost before loading data");

                    // --- Register Data Buffers & Create View (Orchestration still happens here) ---
                    const initialEventsBuffer = new TextEncoder().encode(JSON.stringify(initialEvents));
                    const eventsBuffer = new TextEncoder().encode(JSON.stringify(events));
                    const initialEventsFileName = 'initial_events.json';
                    const eventsFileName = 'events.json';
                    await Promise.all([
                        currentDb.registerFileBuffer(initialEventsFileName, initialEventsBuffer),
                        currentDb.registerFileBuffer(eventsFileName, eventsBuffer)
                    ]);
                    console.log(`Registered ${initialEventsFileName} and ${eventsFileName}`);

                    const fullInitialSchema = [...commonSchema, ...initialOnlySchema];
                    const createInitialTableSql = generateCreateTableSQL('initial_events', fullInitialSchema); // Use imported helper
                    const createEventsTableSql = generateCreateTableSQL('events', commonSchema); // Use imported helper

                    const readInitialJsonColumnsSql = `{${fullInitialSchema.map(c => `\"${c.name}\": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`; // Use imported helper
                    const readEventsJsonColumnsSql = `{${commonSchema.map(c => `\"${c.name}\": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`; // Use imported helper

                    const insertInitialSql = `INSERT INTO initial_events SELECT * FROM read_json('${initialEventsFileName}', auto_detect=false, columns=${readInitialJsonColumnsSql});`;
                    const insertEventsSql = `INSERT INTO events SELECT * FROM read_json('${eventsFileName}', auto_detect=false, columns=${readEventsJsonColumnsSql});`;

                    // Hydration View SQL (logic remains here as it combines schemas)
                    const eventSpecificCols = ['event', 'pathname', 'timestamp', 'properties'];
                    const staticCols = fullInitialSchema.filter(col => !eventSpecificCols.includes(col.name)).map(col => col.name);
                    const staticColFirstValues = staticCols.map(col => `FIRST_VALUE(b.\"${col}\") OVER (PARTITION BY b.session_id ORDER BY b.timestamp) AS \"${col}\"`).join(',\n                 ');
                    const nullPlaceholders = initialOnlySchema.map(c => `NULL AS \"${c.name}\"`).join(', ');
                    const commonSelectColsQuoted = commonSchema.map(c => `\"${c.name}\"`);
                    const allColsSelectString = [...commonSelectColsQuoted, ...initialOnlySchema.map(c => `\"${c.name}\"`)].join(', ');

                    const createAnalyticsViewSql = `
                        DROP VIEW IF EXISTS analytics;
                        CREATE VIEW analytics AS
                        WITH base AS (
                            SELECT ${allColsSelectString} FROM initial_events
                            UNION ALL
                            SELECT ${commonSelectColsQuoted.join(', ')}${initialOnlySchema.length > 0 ? ', ' + nullPlaceholders : ''} FROM events
                        )
                        SELECT b."event", b."pathname", b."timestamp", b."properties", ${staticColFirstValues} FROM base b;
                    `;

                    // Execute SQL Transaction
                    await connection.query('BEGIN TRANSACTION;');
                    try {
                        await Promise.all([
                            connection.query(createInitialTableSql),
                            connection.query(createEventsTableSql)
                        ]);
                        const insertPromises = [];
                        if (initialEvents.length > 0) insertPromises.push(connection.query(insertInitialSql));
                        if (events.length > 0) insertPromises.push(connection.query(insertEventsSql));
                        if (insertPromises.length > 0) await Promise.all(insertPromises);

                        await Promise.all([ currentDb.dropFile(initialEventsFileName), currentDb.dropFile(eventsFileName) ]);
                        await connection.query(createAnalyticsViewSql);

                        const countResult = await connection.query(`SELECT COUNT(*) AS count FROM analytics`);
                        console.log(`Analytics view ready with ${firstRow<{ count: number }>(countResult)?.count ?? 0} events.`);
                        await connection.query('COMMIT;');
                    } catch (txError) {
                        console.error('Transaction failed, rolling back...', txError);
                        await connection.query('ROLLBACK;');
                        throw txError;
                    }

                    set({ status: 'idle', isRefreshing: false });
                    get().runAggregations(); // Trigger aggregations now data is loaded

                } catch (err: any) {
                    console.error("Failed to fetch, load, or merge analytics data:", err);
                    set({error: err.message || 'An unknown error occurred', status: 'error', isRefreshing: false });
                }
            },

            // --- Aggregation Orchestration ---

            runAggregations: async () => {
                const { connection, status, selectedRange, segments } = get();
                if (!connection || !selectedRange?.from || !selectedRange?.to || ['aggregating', 'error', 'loading_data', 'initializing'].includes(status)) {
                    console.log("Skipping aggregations - invalid state or range", { status, selectedRange: !!selectedRange });
                    return;
                }

                set({ status: 'aggregating', error: null });

                try {
                    // Call the imported aggregation runner
                    const newAggregatedData = await runAggregationsSql(connection, selectedRange, segments);

                    // Set base aggregated data first
                    set(state => ({
                        aggregatedData: newAggregatedData,
                        status: 'idle',
                        selectedPropertyKey: state.selectedPropertyKey // Preserve current selection temporarily
                    }));

                    // Trigger dependent aggregations AFTER setting status to idle
                    get().runSankeyAggregation();

                    // Decide which custom property key to aggregate next
                    const currentSelectedKey = get().selectedPropertyKey;
                    const newlyFetchedKeys = newAggregatedData.customProperties?.availableKeys || [];
                    let keyToAggregate: string | null = null;

                    if (currentSelectedKey && newlyFetchedKeys.includes(currentSelectedKey)) {
                        keyToAggregate = currentSelectedKey; // Keep current key if still valid
                    } else if (newlyFetchedKeys.length > 0) {
                        keyToAggregate = newlyFetchedKeys[0]; // Use first available if current is invalid or null
                    }

                    if (keyToAggregate) {
                        // This call will update selectedPropertyKey if needed
                        get().runCustomPropertyAggregation(keyToAggregate);
                    } else {
                        // No keys available, clear selection and results
                        set(state => ({
                            selectedPropertyKey: null,
                            aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: null } } : null,
                        }));
                    }

                } catch (aggregationError: any) {
                    console.error("Error during data aggregation orchestration:", aggregationError);
                    set({ error: aggregationError.message || 'An error occurred during processing.', status: 'error', aggregatedData: null });
                }
            },

            runCustomPropertyAggregation: async (key: string) => {
                const { connection, aggregatedData, status, segments } = get();
                if (!connection || !key || !aggregatedData?.customProperties || ['aggregating', 'error', 'loading_data', 'initializing'].includes(status)) {
                    console.warn("Skipping custom prop aggregation - invalid state or missing data.");
                    return;
                }

                // Set the key being processed and clear old results
                set(state => ({
                    selectedPropertyKey: key,
                    aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: null } } : null,
                }));

                try {
                    // Call the imported SQL function
                    const results = await runCustomPropertyAggregationSql(connection, key, segments);
                    set(state => ({
                        aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: results } } : null,
                    }));
                } catch (error: any) {
                    console.error(`Error aggregating properties for key ${key} in store:`, error);
                    set(state => ({
                        error: error.message || `Error aggregating property '${key}'`, status: 'error', selectedPropertyKey: key, // Keep key even on error
                        aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: [] } } : null, // Clear results on error
                    }));
                }
            },

            runSankeyAggregation: async () => {
                const { connection, status, segments } = get();
                if (!connection || ['aggregating', 'error', 'loading_data', 'initializing'].includes(status)) {
                    console.log(`Skipping Sankey aggregation (status: ${status})`);
                    return;
                }

                try {
                    // Call the imported SQL function
                    const sankeyData = await runSankeyAggregationSql(connection, segments);
                    set({ sankeyData });
                } catch (sankeyError: any) {
                    console.error("Error during Sankey data aggregation in store:", sankeyError);
                    set({ error: sankeyError.message || 'Error during Sankey processing', status: 'error', sankeyData: null });
                }
            },

            // --- Cleanup ---
            cleanup: async () => {
                const { connection, db } = get();
                await cleanupDb(db, connection); // Use imported function
                set({ connection: null, db: null, status: 'idle' });
            },

            // --- Simple Setters ---
            setSourcesTab: (tab: string) => set({ sourcesTab: tab }),
            setPagesTab: (tab: string) => set({ pagesTab: tab }),
            setRegionsTab: (tab: string) => set({ regionsTab: tab }),
            setDevicesTab: (tab: string) => set({ devicesTab: tab }),
            setEventsTab: (tab: string) => set({ eventsTab: tab }),

            // --- Segment Management ---
            addSegment: (segment: Segment) => {
                const currentSegments = get().segments;
                if (!currentSegments.some(s => s.type === segment.type && s.value === segment.value)) {
                    console.log("Adding segment:", segment);
                    set(state => ({ segments: [...state.segments, segment] }));
                    get().runAggregations(); // Re-run aggregations with new segment
                } else {
                     console.log("Segment already exists:", segment);
                }
            },
            removeSegment: (segmentToRemove: Segment) => {
                console.log("Removing segment:", segmentToRemove);
                set(state => ({ segments: state.segments.filter(s => !(s.type === segmentToRemove.type && s.value === segmentToRemove.value)) }));
                get().runAggregations(); // Re-run aggregations without segment
            },
            clearSegments: () => {
                 console.log("Clearing all segments.");
                 set({ segments: [] });
                 get().runAggregations(); // Re-run aggregations with no segments
            },
        }),
        {
            name: 'analytics-store-preferences', // Keep the same name for persistence
            storage: createJSONStorage(() => localStorage),
            partialize: (state): Partial<AnalyticsState> => ({ // Persist only preferences and non-sensitive state
                selectedRange: state.selectedRange, // Let middleware handle serialization
                selectedPropertyKey: state.selectedPropertyKey,
                sourcesTab: state.sourcesTab,
                pagesTab: state.pagesTab,
                regionsTab: state.regionsTab,
                devicesTab: state.devicesTab,
                eventsTab: state.eventsTab,
                selectedSiteId: state.selectedSiteId,
                // Do not persist: db, connection, status, error, aggregatedData, sankeyData, sites, userPreferences, segments, isRefreshing
            }),
            onRehydrateStorage: () => (state, error) => { // Rehydration logic remains similar
                console.log("Rehydrating state...");
                if (error) {
                    console.error("Failed to rehydrate state:", error);
                    return; // Don't proceed if basic rehydration failed
                }
                if (!state) {
                    console.warn("State is undefined during rehydration.");
                    return; // Don't proceed if state is missing
                }

                // Rehydrate date range
                if (state.selectedRange?.from && state.selectedRange.to) {
                    try {
                        const fromDate = parseISO(state.selectedRange.from as unknown as string);
                        const toDate = parseISO(state.selectedRange.to as unknown as string);
                        if (isValid(fromDate) && isValid(toDate)) {
                            state.selectedRange = { from: fromDate, to: toDate };
                            console.log("Rehydrated date range:", state.selectedRange);
                        } else {
                            throw new Error("Invalid date string parsed during rehydration");
                        }
                    } catch (dateError) {
                         console.error("Error parsing persisted dates:", dateError);
                         // Fallback to default if parsing fails
                         state.selectedRange = initialAnalyticsState.selectedRange;
                    }
                } else {
                     // Set default if persisted range is incomplete or missing
                     state.selectedRange = initialAnalyticsState.selectedRange;
                     console.log("Setting default date range during rehydration.");
                }

                // Initialize non-persisted state after rehydration
                state.status = 'idle';
                state.error = null;
                state.aggregatedData = initialAnalyticsState.aggregatedData;
                state.sankeyData = initialAnalyticsState.sankeyData;
                state.sites = []; // Fetch fresh on load
                state.userPreferences = null; // Fetch fresh on load
                state.segments = []; // Segments are not persisted
                state.isRefreshing = false;
                state.db = null; // DB is not persisted
                state.connection = null; // Connection is not persisted

                // Trigger initial data load after rehydration if a site ID was persisted
                if (state.selectedSiteId) {
                    console.log(`Rehydrated with selectedSiteId: ${state.selectedSiteId}. Triggering initial load.`);
                } else {
                    console.log("Rehydrated without selectedSiteId. Waiting for site selection or fetch.");
                     // Attempt to fetch sites if none are selected and none loaded yet
                     setTimeout(() => {
                         const currentState = useStore.getState();
                         if (!currentState.selectedSiteId && currentState.sites.length === 0) {
                             currentState.fetchSites();
                         }
                     }, 0);
                }
            }
        }
    )
);