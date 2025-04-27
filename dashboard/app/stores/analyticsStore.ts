/*
This is the client-side data layer for a web analytics tool. The server sends  the full data payload (rather than aggregated data) for a time range; and the client handles all slice-and-dicing. The pipeline sequence of this file goes like this:

## REST request/response
The server returns `{initial_events, events}`, which looks like the following:
* initial_events: {event, pathname, session_id, timestamp, properties, distinct_id, city, region, country, timezone, device, browser, browser_version, os, os_version, model, manufacturer, referer, referer_domain, screen_height, screen_width, utm_source, utm_campaign, utm_medium, utm_content, utm_term}
* events: {event, pathname, session_id, timestamp, properties}

`initial_events` are the very first event of a browsing session, and captures all valuable data. All subsequent interactions for the same session go to `events`, and capture only "difference" data. The two "tables" are joined via session_id, and sequenced via timestamp. `initial_events` is always the first row in for a series in session_id.

## SQL initialization
A single table (or view, or whatever's best) is created. It merges initial_events with events, by inserting initial_events, and then forward-populating (like pandas.ffill) the matching `events` so that all rows have all the data from their `initial_events`. The final table should have `initial_events` and `events`, where `events` has all columns filled (if not already present) from its `initial_event`.

## Aggregation & slices
Then, various slices of aggregated data are created for use in ../routes/analytics.tsx, to populate cards which show lists, statistics, charts and graphs. These should be generated once until updated from a UI action; and ideally, persisted to the localStorage store so they can be cached for view when the page is next visited (while the page is re-fetching new data).

## Segmentation
In analytics.tsx, any item in a list can be clicked. This applies a "segment" on that item. Eg, if under Top Pages, a user clicks the first page (say "/walk"), it should apply a "WHERE" filter to the master SQL queries, so that all aggregation slices are re-generated with that filter. This allows a user to see "for the /walk route, what are my top referers? what are the common screen dimensions? etc".
 */

import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import * as duckdb from '@duckdb/duckdb-wasm';
import * as arrow from 'apache-arrow';
import { fetchAuthSession } from 'aws-amplify/auth'; // Import fetchAuthSession
import { api, type Site, type UserPreferences } from '../lib/api'; // Import UserPreferences type
import { type DateRange } from 'react-day-picker';
import { subDays, format, startOfDay, endOfDay, isValid, parseISO } from 'date-fns'; // Import date-fns functions

// Import wasm files
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// Endpoints are now constructed within the api helper using VITE_API_URL

// --- Constants ---
const isServer = typeof window === 'undefined';
const SANKEY_MIN_TRANSITION_COUNT = 3; // Minimum transitions for a link to appear
const SANKEY_SQL_LINK_LIMIT = 200;     // Max links fetched from SQL
const SANKEY_MAX_DISPLAY_LINKS = 75;   // Max links processed/displayed in the chart

// --- DuckDB Setup ---
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
    eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

// --- Interfaces ---
export interface AnalyticsEvent {
    event: string;
    pathname?: string | null;
    session_id: string;
    region?: string | null;
    country?: string | null;
    device?: string | null;
    browser?: string | null;
    os?: string | null;
    referer?: string | null;
    referer_domain?: string | null;
    screen_height?: number | null;
    screen_width?: number | null;
    timestamp: Date;
    properties?: string | null;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
}

export interface Stats {
    totalVisits: number;
    totalPageviews: number;
    uniqueVisitors: number;
    viewsPerVisit: number | string;
    visitDuration: string;
    bounceRate: string;
}

export interface ChartDataPoint {
    date: string;
    views: number;
}

export interface CardDataItem {
    name: string;
    value: number;
    events?: number;
    percentage?: number;
}

export interface AggregatedData {
    stats: Stats | null;
    chartData: ChartDataPoint[] | null;
    eventsData: CardDataItem[] | null;
    sources: {
        channels: CardDataItem[];
        sources: CardDataItem[];
        campaigns: CardDataItem[];
    } | null;
    pages: {
        topPages: CardDataItem[];
        entryPages: CardDataItem[];
        exitPages: CardDataItem[];
    } | null;
    regions: {
        countries: CardDataItem[];
        regions: CardDataItem[];
    } | null;
    devices: {
        browsers: CardDataItem[];
        os: CardDataItem[];
        screenSizes: CardDataItem[];
    } | null;
    customProperties: {
        availableKeys: string[];
        aggregatedValues: CardDataItem[] | null;
    } | null;
}

export interface SankeyNode {
    id: string;
    label: string;
}

export interface SankeyLink {
    source: string;
    target: string;
    value: number;
}

export interface SankeyData {
    nodes: SankeyNode[];
    links: SankeyLink[];
}

// Define status types
export type AnalyticsStatus = 'idle' | 'initializing' | 'loading_data' | 'aggregating' | 'error';

// Define Segment structure
export interface Segment {
    type: string;
    value: string | number;
    label: string;
    dbColumn?: string;
   dbValue?: string | number;
}

// Site interface is now imported from api.ts

// Define the initial state structure for resetting
const initialAnalyticsState = {
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
    // Initialize nested structures properly to avoid null issues later
    aggregatedData: {
        stats: null, chartData: null, eventsData: null, sources: null, pages: null, regions: null, devices: null,
        customProperties: { availableKeys: [], aggregatedValues: null }
    },
   sankeyData: { nodes: [], links: [] },
   sites: [] as Site[], // Initialize sites state with type
   selectedSiteId: null as string | null, // Initialize selectedSiteId state with type
   userPreferences: null as UserPreferences | null, // Added
};

export interface AnalyticsState {
   db: duckdb.AsyncDuckDB | null;
    connection: duckdb.AsyncDuckDBConnection | null;
    status: AnalyticsStatus;
    error: string | null;
    selectedRange: DateRange | undefined; // Updated type
    aggregatedData: AggregatedData | null;
    selectedPropertyKey: string | null;
    sankeyData: SankeyData | null;
    isRefreshing: boolean;
  segments: Segment[];
  sites: Site[]; // Add sites state
  selectedSiteId: string | null; // Add selectedSiteId state
  userPreferences: UserPreferences | null; // Added

  // Card Tab Preferences
   sourcesTab: string;
    pagesTab: string;
    regionsTab: string;
    devicesTab: string;
    eventsTab: string;

  resetAnalyticsState: () => Partial<AnalyticsState>;
  setSelectedRange: (range: DateRange | undefined) => void; // Updated type
  fetchSites: () => Promise<void>; // Add fetchSites action
  setSelectedSiteId: (siteId: string | null) => void; // Add setSelectedSiteId action
  fetchAndLoadData: () => Promise<void>;
   runAggregations: () => Promise<void>;
   runCustomPropertyAggregation: (key: string) => Promise<void>;
    runSankeyAggregation: () => Promise<void>;
    cleanup: () => Promise<void>;
    _initializeDb: () => Promise<{ db: duckdb.AsyncDuckDB | null; connection: duckdb.AsyncDuckDBConnection | null }>;
    _fetchData: () => Promise<{ // Removed range parameter
        initialEvents: any[];
        events: any[];
        commonSchema: { name: string; type: string }[];
        initialOnlySchema: { name: string; type: string }[];
    }>;
    setSourcesTab: (tab: string) => void;
    setPagesTab: (tab: string) => void;
    setRegionsTab: (tab: string) => void;
    setDevicesTab: (tab: string) => void;
    setEventsTab: (tab: string) => void;
    addSegment: (segment: Segment) => void;
    removeSegment: (segmentToRemove: Segment) => void;
    clearSegments: () => void;
}


// --- Helper Functions ---

const arrowTableToObjects = <T extends Record<string, any>>(table: arrow.Table | null): T[] => {
    if (!table || table.numRows === 0) return [];
    const objects: T[] = [];
    for (let i = 0; i < table.numRows; i++) {
        const row = table.get(i);
        if (row) {
            const obj: Record<string, any> = {};
            for (const field of table.schema.fields) {
                const value = row[field.name];
                if (typeof value === 'bigint') {
                     obj[field.name] = Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
                } else {
                    obj[field.name] = value;
                }
            }
            objects.push(obj as T);
        }
    }
    return objects;
};

const firstRow = <T extends Record<string, any>>(table: arrow.Table | null): T | undefined => arrowTableToObjects<T>(table)[0];

function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return 'N/A';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  if (seconds > 0) return `${seconds}s`;
  return '0s';
}

const mapSchemaToDuckDBType = (schemaType: string): string => {
  switch (schemaType.toLowerCase()) {
    case 'string':
    case 'map<string,string>': return 'VARCHAR';
    case 'timestamp': return 'TIMESTAMP';
    default:
      console.warn(`Unknown schema type "${schemaType}", defaulting to VARCHAR.`);
      return 'VARCHAR';
  }
};

const toCards = <T extends { name: string; value: number; percentage?: number }>(rows: (T & { type: string })[], type: string): CardDataItem[] =>
   rows.filter(r => r.type === type).map(({ name, value, percentage }) => ({ name, value, percentage }));

// timeFmt is no longer needed as we use specific dates

const _generateCreateTableSQL = (tableName: string, schema: { name: string; type: string }[]): string => {
    const columns = schema
        .map(col => `\"${col.name}\" ${mapSchemaToDuckDBType(col.type)}`)
        .join(',\n ');
    return `
        DROP TABLE IF EXISTS ${tableName};
        CREATE TABLE ${tableName} (
            ${columns}
        );
    `;
};

const _generateWhereClause = (segments: Segment[]): string => {
    if (segments.length === 0) return 'WHERE 1=1';

    const conditions = segments.map(segment => {
        const column = segment.dbColumn || `\"${segment.type}\"`;
        let value = segment.dbValue !== undefined ? segment.dbValue : segment.value;
        const quotedValue = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : value;

        if (segment.type.startsWith('custom:')) {
            const propKey = segment.type.split(':')[1].replace(/[^a-zA-Z0-9_]/g, '');
            return `json_extract_string(properties, '$.${propKey}') = ${quotedValue}`;
        } else if (segment.type === 'screen_size') {
             // Special handling: screen size is derived, not a direct column
             return `(screen_width::VARCHAR || 'x' || screen_height::VARCHAR) = ${quotedValue}`;
        } else if (segment.type === 'channel') {
            // Special handling: Map channel names back to complex DB conditions
            const lowerValue = String(value).toLowerCase();
             if (lowerValue === 'direct') return "COALESCE(referer_domain, '$direct', 'Unknown') = '$direct'";
             if (lowerValue === 'organic search') return `LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) IN ('google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu')`;
             if (lowerValue === 'social') return `LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) IN ('facebook.com', 't.co', 'twitter.com', 'linkedin.com', 'instagram.com', 'pinterest.com', 'reddit.com')`;
             if (lowerValue === 'referral') return `(COALESCE(referer_domain, '$direct', 'Unknown') IS NOT NULL AND LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) NOT IN ('$direct', 'unknown', 'google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu', 'facebook.com', 't.co', 'twitter.com', 'linkedin.com', 'instagram.com', 'pinterest.com', 'reddit.com'))`;
             return `COALESCE(referer_domain, '$direct', 'Unknown') = 'Unknown'`; // Default/Unknown
        } else if (segment.type === 'referer_domain') {
             // Special handling: strip www. from DB value for comparison, handle '$direct'
             if (value === '$direct') {
                 return `COALESCE(referer_domain, '$direct', 'Unknown') = '$direct'`;
             } else {
                 // Need to double-escape the backslash in the regex string for SQL
                 return `regexp_replace(COALESCE(referer_domain, '$direct', 'Unknown'), '^www\\.', '') = ${quotedValue}`;
             }
        } else {
            // Default: simple equality check
            return `${column} = ${quotedValue}`;
        }
    });

    return `WHERE ${conditions.join(' AND ')}`;
};

function buildSankeyData(rawLinks: { source_node: string; target_node: string; value: number }[]): SankeyData {
    if (!rawLinks?.length) return { nodes: [], links: [] };

    const preliminaryLinks: SankeyLink[] = rawLinks
        .filter(r => r.source_node && r.target_node && r.source_node !== r.target_node && r.value >= SANKEY_MIN_TRANSITION_COUNT) // Apply min count here
        .map(({ source_node, target_node, value }) => ({ source: source_node, target: target_node, value }));

    preliminaryLinks.sort((a, b) => b.value - a.value);

    const links = preliminaryLinks.slice(0, SANKEY_MAX_DISPLAY_LINKS); // Use constant

    const nodesSet = new Set<string>();
    links.forEach(({ source, target }) => {
        nodesSet.add(source);
        nodesSet.add(target);
    });

    const nodes: SankeyNode[] = Array.from(nodesSet).map(id => ({
        id,
        label: id.replace(/ #\d+$/, '') // Clean label by removing step index
    }));
    return { nodes, links };
}

// --- Zustand Store ---
export const useStore = create<AnalyticsState>()(
    persist(
        (set, get) => ({
            db: null,
            connection: null,
            status: 'idle',
            isRefreshing: false,
            // selectedRange is initialized via initialAnalyticsState
            ...initialAnalyticsState,

            resetAnalyticsState: () => {
                const currentStatus = get().status;
                const currentAggData = get().aggregatedData;
                const currentSelectedKey = get().selectedPropertyKey;
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
                    selectedPropertyKey: currentSelectedKey,
                    // Keep sites, selectedSiteId, selectedRange, and userPreferences during reset unless explicitly changed elsewhere
                    sites: get().sites,
                    selectedSiteId: get().selectedSiteId,
                    selectedRange: get().selectedRange,
                    userPreferences: get().userPreferences, // Keep user preferences
                };
            },

            _initializeDb: async () => {
                if (get().db || isServer) return { db: get().db, connection: get().connection };
                console.log("Initializing DuckDB...");
                try {
                    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
                    const worker = new Worker(bundle.mainWorker!);
                    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
                    const db = new duckdb.AsyncDuckDB(logger, worker);
                    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
                    await db.open({ query: { castTimestampToDate: true } }); // Enable automatic casting
                    const connection = await db.connect();
                    console.log("DuckDB Initialized.");
                    return { db, connection };
                } catch (error: any) {
                    console.error("DuckDB Initialization Failed:", error);
                    throw error;
                }
            },

            _fetchData: async () => {
                const { selectedSiteId, selectedRange } = get();
                if (!selectedSiteId) throw new Error("No site selected for fetching data.");
                if (!selectedRange?.from || !selectedRange?.to) throw new Error("Date range not selected for fetching data.");

                // Format dates for query parameters
                const startDateParam = format(selectedRange.from, 'yyyy-MM-dd');
                const endDateParam = format(selectedRange.to, 'yyyy-MM-dd');

                // Construct the endpoint path with query parameters
                const endpoint = `/api/query?siteId=${selectedSiteId}&startDate=${startDateParam}&endDate=${endDateParam}`;
                console.log(`Fetching query data from endpoint: ${endpoint}`);

                // Use the api helper which handles base URL and auth
                const data = await api.get<any>(endpoint); // Define a proper type for the response later

                const { initialEvents, events, commonSchema, initialOnlySchema } = data;

                // Validate the structure of the received data
                if (!Array.isArray(initialEvents) || !Array.isArray(events) || !Array.isArray(commonSchema) || !Array.isArray(initialOnlySchema)) {
                    throw new Error("Invalid data structure received from /api/query endpoint.");
                }

                console.log(`Received ${initialEvents.length} initial events, ${events.length} subsequent events, ${commonSchema.length} common fields, ${initialOnlySchema.length} initial-only fields.`);
                return { initialEvents, events, commonSchema, initialOnlySchema };
            },

            fetchSites: async () => {
                console.log("AnalyticsStore: fetchSites called."); // Log entry
                console.log("Fetching sites and user preferences...");
                try {
                    // Fetch sites and preferences concurrently using only the path
                    console.log("AnalyticsStore: Attempting api.get('/api/sites') and api.get('/api/user/preferences')..."); // Log before API calls
                    const [fetchedSites, fetchedPreferences] = await Promise.all([
                        api.get<Site[]>('/api/sites'),
                        api.get<UserPreferences>('/api/user/preferences')
                    ]);

                    console.log(`Fetched ${fetchedSites.length} sites and user preferences.`);
                    set(state => {
                        const currentSelectedId = state.selectedSiteId;
                        // If no site is selected OR the selected site is no longer valid, select the first one
                        const newSelectedSiteId = (!currentSelectedId || !fetchedSites.some(s => s.site_id === currentSelectedId)) && fetchedSites.length > 0
                            ? fetchedSites[0].site_id
                            : currentSelectedId;

                        return {
                            sites: fetchedSites,
                            userPreferences: fetchedPreferences, // Store preferences
                            selectedSiteId: newSelectedSiteId,
                            // Trigger data load only if a site is now selected
                            status: newSelectedSiteId ? state.status : 'idle',
                            error: null // Clear previous errors
                        };
                    });
                    // If a site is now selected, trigger data fetch
                    if (get().selectedSiteId) {
                        get().fetchAndLoadData();
                    } else if (fetchedSites.length === 0) {
                         set({ status: 'idle', error: 'No sites found for this user.', aggregatedData: null }); // Handle no sites case
                    }
                } catch (err: any) {
                    console.error("Failed to fetch sites or preferences:", err);
                    // Set specific error messages if possible, otherwise generic
                    const errorMessage = err.message || 'Failed to fetch initial data.';
                    set({ status: 'error', error: errorMessage, sites: [], userPreferences: null, selectedSiteId: null, aggregatedData: null });
                }
            },

            setSelectedSiteId: (siteId: string | null) => {
                if (siteId === get().selectedSiteId) return;
                console.log(`Setting selected site ID to: ${siteId}`);
                set({
                    selectedSiteId: siteId,
                    ...get().resetAnalyticsState(), // Reset analytics data, keep site selection
                    segments: [] // Clear segments when site changes
                 });
                 if (siteId) {
                    get().fetchAndLoadData(); // Fetch data for the new site
                 } else {
                    // Handle case where selection is cleared (e.g., show a message)
                    set({ aggregatedData: null, status: 'idle', error: 'Please select a site.' });
                 }
            },

            setSelectedRange: (range: DateRange | undefined) => {
                // Basic comparison, might need deep compare if objects cause issues
                if (JSON.stringify(range) === JSON.stringify(get().selectedRange)) return;
                 set({
                     selectedRange: range,
                     ...get().resetAnalyticsState(), // Reset analytics, keep range
                     segments: [] // Clear segments when range changes
                 });
                 get().fetchAndLoadData(); // Fetch data for the new range
            },

            fetchAndLoadData: async () => {
                console.log("AnalyticsStore: fetchAndLoadData called."); // Log entry
                if (get().isRefreshing) {
                    console.log("AnalyticsStore: fetchAndLoadData skipped (already refreshing).");
                    return;
                }

                const { status, selectedSiteId, db, selectedRange } = get(); // Get selectedRange here

                // Initialize DB and fetch sites if not already done
                if (!db) {
                    console.log("DB not initialized, initializing and fetching sites...");
                    set({ status: 'initializing' });
                    try {
                        const dbResult = await get()._initializeDb(); // Get result to set state
                        set({ db: dbResult.db, connection: dbResult.connection }); // Set DB state
                        await get().fetchSites(); // Fetch sites after DB init
                        // fetchSites will trigger fetchAndLoadData again if a site is selected
                        return; // Exit here, let the triggered call handle data fetching
                    } catch (initError: any) {
                        console.error("Initialization or site fetch failed:", initError);
                        set({ status: 'error', error: initError.message || 'Initialization failed', isRefreshing: false });
                        return;
                    }
                }

                // If DB is ready but no site is selected, wait. fetchSites should handle this.
                if (!selectedSiteId) {
                    console.log("No site selected, waiting for site selection.");
                    // Check if sites have been fetched, if not, fetch them.
                    if (get().sites.length === 0 && status !== 'error') {
                        console.log("No sites loaded, attempting to fetch sites.");
                        await get().fetchSites();
                    } else if (get().sites.length === 0 && status === 'idle') {
                         set({ status: 'idle', error: 'No sites found. Please create a site first.' });
                    }
                    return; // Don't proceed without a site ID
                }

                // Check if date range is valid before fetching
                if (!selectedRange?.from || !selectedRange?.to) {
                    console.log("Date range not fully selected, skipping data fetch.");
                    // Optionally set an error or specific status
                    // set({ status: 'idle', error: 'Please select a valid date range.' });
                    return;
                }

                if (status === 'loading_data' || status === 'initializing' || status === 'aggregating') return;

                console.log(`Fetching data for site ${selectedSiteId}, range: ${format(selectedRange.from, 'P')} - ${format(selectedRange.to, 'P')}`);
                // Reset analytics state but keep site selection and site list
                set(state => ({
                    isRefreshing: true,
                    status: 'loading_data',
                    ...state.resetAnalyticsState(), // Resets data/segments/error etc.
                    sites: state.sites, // Keep existing sites list
                    selectedSiteId: state.selectedSiteId, // Keep current site selection
                    selectedRange: state.selectedRange // Keep current range selection
                }));


                try {
                    // Fetch data only, DB is already initialized
                    const fetchedData = await get()._fetchData(); // _fetchData uses range from state

                    const { initialEvents, events, commonSchema, initialOnlySchema } = fetchedData;
                    const fullInitialSchema = [...commonSchema, ...initialOnlySchema];

                    // DB and connection should already be set by the time we get here
                    const { db: currentDb, connection } = get(); // Renamed db to currentDb to avoid conflict
                    if (!currentDb || !connection) throw new Error("Database connection lost"); // Check again just in case

                    // --- Register Data Buffers ---
                    const initialEventsBuffer = new TextEncoder().encode(JSON.stringify(initialEvents));
                    const eventsBuffer = new TextEncoder().encode(JSON.stringify(events));
                    const initialEventsFileName = 'initial_events.json';
                    const eventsFileName = 'events.json';
                    await Promise.all([
                        currentDb.registerFileBuffer(initialEventsFileName, initialEventsBuffer),
                        currentDb.registerFileBuffer(eventsFileName, eventsBuffer)
                    ]);
                    console.log(`Registered ${initialEventsFileName} and ${eventsFileName}`);

                    // --- SQL ---
                    const createInitialTableSql = _generateCreateTableSQL('initial_events', fullInitialSchema);
                    const createEventsTableSql = _generateCreateTableSQL('events', commonSchema);

                    const readInitialJsonColumnsSql = `{${fullInitialSchema.map(c => `\"${c.name}\": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`;
                    const readEventsJsonColumnsSql = `{${commonSchema.map(c => `\"${c.name}\": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`;

                    const insertInitialSql = `INSERT INTO initial_events SELECT * FROM read_json('${initialEventsFileName}', auto_detect=false, columns=${readInitialJsonColumnsSql});`;
                    const insertEventsSql = `INSERT INTO events SELECT * FROM read_json('${eventsFileName}', auto_detect=false, columns=${readEventsJsonColumnsSql});`;

                    // Hydration View SQL
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

                    // --- Execute SQL Transaction ---
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
                    get().runAggregations();

                } catch (err: any) {
                    console.error("Failed to fetch, load, or merge analytics data:", err);
                    set({error: err.message || 'An unknown error occurred', status: 'error', isRefreshing: false });
                }
            },

            runAggregations: async () => {
                const {connection, status, selectedRange, segments} = get(); // selectedRange is now DateRange | undefined
                if (!connection || status === 'aggregating' || status === 'error' || status === 'loading_data' || !selectedRange?.from || !selectedRange?.to) {
                    console.log("Skipping aggregations - invalid state or range", { status, selectedRange });
                    return;
                }

                console.log("Running aggregations...");
                set({status: 'aggregating', error: null});

                const whereClause = _generateWhereClause(segments);
                console.log("Aggregating with WHERE clause:", whereClause);

                try {
                    // Stats Query (Using FILTER, removed one timestamp cast)
                    const statsQuery = `
                        WITH SessionPageViews AS (
                            SELECT session_id,
                                   COUNT(*) FILTER (WHERE event = 'page_view') as page_view_count
                            FROM analytics ${whereClause} GROUP BY session_id
                        ), SessionDurations AS (
                             SELECT session_id, epoch_ms(MAX(timestamp)) - epoch_ms(MIN(timestamp)) AS duration_ms
                             FROM analytics ${whereClause} GROUP BY session_id HAVING COUNT(*) > 1
                        ), BouncedSessions AS (
                             SELECT COUNT(session_id) AS bouncedSessionsCount FROM SessionPageViews WHERE page_view_count = 1
                        ), TotalVisitors AS (
                             SELECT COUNT(DISTINCT session_id) AS uniqueVisitors FROM analytics ${whereClause}
                        ), TotalPageviews AS (
                             SELECT COUNT(*) FILTER (WHERE event = 'page_view') AS totalPageviews FROM analytics ${whereClause}
                        ), MedianDurationStat AS ( -- Renamed CTE
                             SELECT COALESCE(MEDIAN(duration_ms) / 1000.0, 0) AS median_duration_seconds FROM SessionDurations -- Changed AVG to MEDIAN and renamed alias
                        )
                        SELECT tv.uniqueVisitors, tp.totalPageviews, mds.median_duration_seconds, -- Changed alias reference
                               CASE WHEN tv.uniqueVisitors > 0 THEN (bs.bouncedSessionsCount::DOUBLE / tv.uniqueVisitors) * 100.0 ELSE 0 END AS bounce_rate_percentage
                        FROM TotalVisitors tv, TotalPageviews tp, BouncedSessions bs, MedianDurationStat mds; -- Changed CTE reference
                    `;
                    const statsPromise = connection.query(statsQuery).then(result => {
                        const res = firstRow<{ uniqueVisitors: number; totalPageviews: number; median_duration_seconds: number | null; bounce_rate_percentage: number | null; }>(result); // Updated type
                        if (!res) return { totalVisits: 0, totalPageviews: 0, uniqueVisitors: 0, viewsPerVisit: 'N/A', visitDuration: 'N/A', bounceRate: 'N/A' };
                        const { uniqueVisitors: totalVisits, totalPageviews, median_duration_seconds, bounce_rate_percentage } = res; // Updated destructuring
                        return {
                            totalVisits, totalPageviews, uniqueVisitors: totalVisits,
                            viewsPerVisit: totalVisits ? (totalPageviews / totalVisits).toFixed(2) : 'N/A',
                            visitDuration: formatDuration(median_duration_seconds), // Updated variable passed to formatDuration
                            bounceRate: bounce_rate_percentage !== null ? `${bounce_rate_percentage.toFixed(1)}%` : 'N/A',
                        };
                    });

                    // Chart Data Query - Group by hour if range is 1 day or less, else by day
                    const daysDiff = selectedRange.to.getTime() - selectedRange.from.getTime();
                    const oneDayMs = 24 * 60 * 60 * 1000;
                    const timeFormat = daysDiff <= oneDayMs ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

                    const chartDataQuery = `
                        SELECT strftime(timestamp, '${timeFormat}') AS date, COUNT(*) AS views
                        FROM analytics ${whereClause} AND event = 'page_view'
                        GROUP BY date ORDER BY date;
                    `;
                    const chartDataPromise = connection.query(chartDataQuery).then(arrowTableToObjects<ChartDataPoint>);

                    // Sources Query
                    const sourcesQuery = `
                        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
                        SourceMapping AS (
                            SELECT session_id, COALESCE(referer_domain, '$direct', 'Unknown') AS raw_source,
                                   LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) AS referrer_lower,
                                   utm_source, utm_medium, utm_campaign,
                                   CASE
                                       WHEN utm_medium = 'cpc' OR utm_medium = 'ppc' THEN 'Paid Search'
                                       WHEN utm_medium = 'email' OR list_contains(['mail.google.com', 'com.google.android.gm'], referrer_lower) THEN 'Email'
                                       WHEN utm_medium = 'social' OR list_contains([
                                            'facebook', 'twitter', 'linkedin', 'instagram', 'pinterest', 'reddit', 't.co',
                                            'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'pinterest.com', 'reddit.com',
                                            'com.reddit.frontpage', 'old.reddit.com', 'youtube.com', 'm.youtube.com'
                                           ], referrer_lower) THEN 'Social'
                                       WHEN list_contains([
                                            'google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu',
                                            'google.com', 'google.co.uk', 'google.com.hk', 'yandex.ru', 'search.brave.com', 'perplexity.ai'
                                           ], referrer_lower) THEN 'Organic Search'
                                       WHEN referrer_lower = '$direct' THEN 'Direct'
                                       WHEN referrer_lower = 'Unknown' THEN 'Unknown'
                                       WHEN referrer_lower IS NOT NULL AND referrer_lower != '$direct' THEN 'Referral' -- Catchall for non-direct, non-special referrers
                                       ELSE 'Unknown'
                                   END AS channel
                            FROM FilteredAnalytics
                        ),
                        ChannelCounts AS ( SELECT channel AS name, COUNT(DISTINCT session_id) AS value FROM SourceMapping GROUP BY channel ),
                        SourceCounts AS ( SELECT CASE WHEN raw_source = '$direct' THEN '$direct' ELSE regexp_replace(raw_source, '^www\\.', '') END AS name, COUNT(DISTINCT session_id) AS value FROM SourceMapping GROUP BY name ),
                        CampaignCounts AS ( SELECT COALESCE(utm_campaign, '(not set)') AS name, COUNT(DISTINCT session_id) AS value FROM SourceMapping WHERE utm_campaign IS NOT NULL GROUP BY name )
                        SELECT 'channels' as type, name, value FROM ChannelCounts WHERE value > 0
                        UNION ALL SELECT 'sources' as type, name, value FROM SourceCounts WHERE value > 0
                        UNION ALL SELECT 'campaigns' as type, name, value FROM CampaignCounts WHERE value > 0
                        ORDER BY type, value DESC LIMIT 300;
                    `;
                    const sourcesPromise = connection.query(sourcesQuery).then(result => {
                        const rows = arrowTableToObjects<{ type: string; name: string; value: number }>(result);
                        return { channels: toCards(rows, 'channels'), sources: toCards(rows, 'sources'), campaigns: toCards(rows, 'campaigns') };
                    });

                    // Pages Query
                    const pagesQuery = `
                        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
                        PageViews AS ( SELECT session_id, pathname, timestamp FROM FilteredAnalytics WHERE event = 'page_view' AND pathname IS NOT NULL AND trim(pathname) != '' ),
                        RankedPageViews AS ( SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp ASC) as rn_asc, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp DESC) as rn_desc FROM PageViews ),
                        TopPages AS ( SELECT pathname AS name, COUNT (*) AS value FROM RankedPageViews GROUP BY pathname ),
                        EntryPages AS ( SELECT pathname AS name, COUNT (*) AS value FROM RankedPageViews WHERE rn_asc = 1 GROUP BY pathname ),
                        ExitPages AS ( SELECT pathname AS name, COUNT (*) AS value FROM RankedPageViews WHERE rn_desc = 1 GROUP BY pathname )
                        SELECT 'topPages' as type, name, value FROM TopPages WHERE value > 0
                        UNION ALL SELECT 'entryPages' as type, name, value FROM EntryPages WHERE value > 0
                        UNION ALL SELECT 'exitPages' as type, name, value FROM ExitPages WHERE value > 0
                        ORDER BY type, value DESC LIMIT 300;
                    `;
                    const pagesPromise = connection.query(pagesQuery).then(result => {
                        const rows = arrowTableToObjects<{ type: string; name: string; value: number }>(result);
                        return { topPages: toCards(rows, 'topPages'), entryPages: toCards(rows, 'entryPages'), exitPages: toCards(rows, 'exitPages') };
                    });

                    // Regions Query
                    const regionsQuery = `
                        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
                        CountryCounts AS ( SELECT COALESCE(country, 'Unknown') AS name, COUNT(DISTINCT session_id) AS value FROM FilteredAnalytics GROUP BY name ),
                        RegionCounts AS ( SELECT COALESCE(region, 'Unknown') AS name, COUNT(DISTINCT session_id) AS value FROM FilteredAnalytics GROUP BY name )
                        SELECT 'countries' as type, name, value FROM CountryCounts WHERE value > 0
                        UNION ALL SELECT 'regions' as type, name, value FROM RegionCounts WHERE value > 0 AND name != 'Unknown'
                        ORDER BY type, value DESC LIMIT 200;
                    `;
                    const regionsPromise = connection.query(regionsQuery).then(result => {
                        const rows = arrowTableToObjects<{ type: string; name: string; value: number }>(result);
                        return { countries: toCards(rows, 'countries'), regions: toCards(rows, 'regions') };
                    });

                    // Devices Query
                    const devicesQuery = `
                        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
                        VisitorCounts AS (
                            SELECT session_id, FIRST(COALESCE(browser, 'Unknown')) as browser, FIRST(COALESCE(os, 'Unknown')) as os,
                                   FIRST(CASE WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL THEN screen_width::VARCHAR || 'x' || screen_height::VARCHAR ELSE 'Unknown' END) as screen_size -- Derive screen_size
                            FROM FilteredAnalytics GROUP BY session_id
                        ),
                        TotalVisitors AS ( SELECT COUNT(*) as total FROM VisitorCounts ),
                        BrowserCounts AS ( SELECT browser AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name ),
                        OsCounts AS ( SELECT os AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name ),
                        ScreenSizeCounts AS ( SELECT screen_size AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name )
                        SELECT 'browsers' as type, BC.name, BC.value, (BC.value::DOUBLE / TV.total) * 100 AS percentage FROM BrowserCounts BC, TotalVisitors TV WHERE BC.value > 0
                        UNION ALL SELECT 'os' as type, OC.name, OC.value, (OC.value::DOUBLE / TV.total) * 100 AS percentage FROM OsCounts OC, TotalVisitors TV WHERE OC.value > 0
                        UNION ALL SELECT 'screenSizes' as type, SC.name, SC.value, (SC.value::DOUBLE / TV.total) * 100 AS percentage FROM ScreenSizeCounts SC, TotalVisitors TV WHERE SC.value > 0 AND SC.name != 'Unknown' -- Filter unknown screen sizes
                        ORDER BY type, value DESC LIMIT 300;
                    `;
                    const devicesPromise = connection.query(devicesQuery).then(result => {
                        const rows = arrowTableToObjects<{ type: string; name: string; value: number; percentage: number }>(result);
                        return { browsers: toCards(rows, 'browsers'), os: toCards(rows, 'os'), screenSizes: toCards(rows, 'screenSizes') };
                    });

                    // Events Query (Using FILTER)
                    const eventsQuery = `
                       WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
                        EventCounts AS (
                            SELECT COALESCE(event, 'Unknown') AS name,
                                COUNT(*) as events, COUNT(DISTINCT session_id) as value
                            FROM FilteredAnalytics GROUP BY name
                        ), TotalVisitors AS ( SELECT COUNT(DISTINCT session_id) as total FROM FilteredAnalytics )
                        SELECT E.name, E.value, E.events,
                               CASE WHEN T.total > 0 THEN (E.value::DOUBLE / T.total) * 100 ELSE 0 END AS percentage
                        FROM EventCounts E, TotalVisitors T WHERE E.value > 0 ORDER BY E.value DESC LIMIT 100;
                    `;
                    const eventsPromise = connection.query(eventsQuery).then(arrowTableToObjects<CardDataItem>);

                    // Available Custom Property Keys Query
                    const keysQuery = `
                        SELECT DISTINCT unnest(json_keys(json(properties))) AS key
                        FROM analytics WHERE json_valid(properties) ORDER BY key;
                    `;
                    const keysPromise = connection.query(keysQuery).then(result => arrowTableToObjects<{ key: string }>(result).map(row => row.key))
                        .catch(err => { console.warn("Could not get custom property keys:", err); return []; });

                    // --- Execute & Combine ---
                    const [stats, chartData, sources, pages, regions, devices, eventsData, availableKeys] = await Promise.all([
                        statsPromise, chartDataPromise, sourcesPromise, pagesPromise, regionsPromise, devicesPromise, eventsPromise, keysPromise
                    ]);

                    const newAggregatedData: AggregatedData = {
                        stats, chartData, eventsData, sources, pages, regions, devices,
                        customProperties: { availableKeys, aggregatedValues: null }
                    };

                    console.log("Aggregation complete.");
                    // Set base aggregated data first, keep existing selected key for now
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
                    console.error("Error during data aggregation:", aggregationError);
                    set({error: aggregationError.message || 'An error occurred during processing.', status: 'error', aggregatedData: null});
                }
            },

            runCustomPropertyAggregation: async (key: string) => {
                const {connection, aggregatedData, status, segments} = get();
                const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '');
                if (!connection || !safeKey || !aggregatedData?.customProperties || ['aggregating', 'error'].includes(status)) return;

                const whereClause = _generateWhereClause(segments);
                console.log(`Aggregating custom prop '${safeKey}' with WHERE: ${whereClause}`);
                set(state => ({
                    selectedPropertyKey: safeKey,
                    aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: null } } : null,
                }));

                try {
                    const query = `
                        WITH FilteredAnalytics AS ( SELECT session_id, properties FROM analytics ${whereClause} ),
                        Extracted AS (
                           SELECT session_id, json_extract_string(properties, '$.${safeKey}') as prop_value
                           FROM FilteredAnalytics WHERE json_valid(properties) AND json_extract_string(properties, '$.${safeKey}') IS NOT NULL
                        ), Aggregated AS (
                           SELECT COALESCE(prop_value, '(not set)') AS name, COUNT(DISTINCT session_id) AS value, COUNT(*) AS events
                           FROM Extracted GROUP BY name
                        ), Total AS ( SELECT SUM(value) as total_value FROM Aggregated )
                        SELECT A.name, A.value, A.events, CASE WHEN T.total_value > 0 THEN (A.value::DOUBLE / T.total_value) * 100 ELSE 0 END AS percentage
                        FROM Aggregated A, Total T WHERE A.value > 0 ORDER BY A.value DESC LIMIT 100;
                    `;
                    const resultsResult = await connection.query(query);
                    const results = arrowTableToObjects<CardDataItem>(resultsResult);

                    set(state => ({
                        aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: results } } : null,
                    }));
                    console.log(`Custom property aggregation complete for key: ${key}.`);
                } catch (error: any) {
                    console.error(`Error aggregating properties for key ${safeKey}:`, error);
                    set(state => ({
                        error: error.message || `Error aggregating property '${safeKey}'`, status: 'error', selectedPropertyKey: safeKey,
                        aggregatedData: state.aggregatedData ? { ...state.aggregatedData, customProperties: { ...state.aggregatedData.customProperties!, aggregatedValues: [] } } : null,
                    }));
                }
            },

            runSankeyAggregation: async () => {
                const {connection, status, segments} = get();
                if (!connection || ['aggregating', 'error', 'loading_data', 'initializing'].includes(status)) {
                    console.log(`Skipping Sankey aggregation (status: ${status})`);
                    return;
                }

                console.log("Running Sankey aggregation...");
                const whereClause = _generateWhereClause(segments);
                console.log("Sankey aggregating with WHERE clause:", whereClause);

                try {
                    const sankeyQuery = `
                        WITH MatchingSessions AS (
                            -- Select distinct session IDs that match the filter criteria
                            SELECT DISTINCT session_id FROM analytics ${whereClause}
                        ), SessionEvents AS (
                            -- Select all events for the matching sessions
                            SELECT a.session_id, a.timestamp, a.event, a.pathname
                            FROM analytics a JOIN MatchingSessions ms ON a.session_id = ms.session_id
                        ), RawEvents AS (
                            -- Process events from the selected sessions
                            SELECT session_id, timestamp, CASE WHEN event = 'page_view' THEN '📃 ' || COALESCE(pathname, '[unknown]') ELSE '🖱️ ' || event END AS base_node
                            FROM SessionEvents -- Use SessionEvents instead of FilteredAnalytics
                        ), Deduped AS (
                            SELECT *, LAG(base_node) OVER (PARTITION BY session_id ORDER BY timestamp) AS prev_node FROM RawEvents
                        ), DistinctSteps AS (
                            SELECT session_id, timestamp, base_node, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp) AS step_idx
                            FROM Deduped WHERE prev_node IS NULL OR base_node <> prev_node
                        ), LabeledNodes AS (
                            SELECT session_id, timestamp, CONCAT(base_node, ' #', step_idx) AS node_id, step_idx FROM DistinctSteps
                        ), NodePairs AS (
                            SELECT session_id, node_id AS source_node, LEAD(node_id) OVER (PARTITION BY session_id ORDER BY step_idx) AS target_node
                            FROM LabeledNodes
                        ), TransitionCounts AS (
                            SELECT source_node, target_node, COUNT(*) AS value FROM NodePairs WHERE target_node IS NOT NULL
                            GROUP BY source_node, target_node
                        )
                        SELECT source_node, target_node, value FROM TransitionCounts
                        -- Filter for min transitions already applied in buildSankeyData helper
                        ORDER BY value DESC LIMIT ${SANKEY_SQL_LINK_LIMIT}; -- Use constant
                    `;

                    const result = await connection.query(sankeyQuery);
                    const rawLinksData = arrowTableToObjects<{ source_node: string; target_node: string; value: number }>(result);

                    if (!rawLinksData || rawLinksData.length === 0) {
                        console.warn("Sankey aggregation returned no links data.");
                        set({sankeyData: {nodes: [], links: []}});
                        return;
                    }

                    const { nodes, links } = buildSankeyData(rawLinksData);
                    console.log(`Sankey aggregation complete. Found ${nodes.length} nodes and ${links.length} links.`);
                    set({sankeyData: {nodes, links}});

                } catch (sankeyError: any) {
                    console.error("Error during Sankey data aggregation:", sankeyError);
                    set({error: sankeyError.message || 'Error during Sankey processing', status: 'error', sankeyData: null});
                }
            },

            cleanup: async () => {
                console.log("Cleaning up DuckDB...");
                const {connection, db} = get();
                try { await connection?.close(); } catch (e) { console.error("Error closing connection:", e); }
                try { await db?.terminate(); } catch (e) { console.error("Error terminating DB:", e); }
                set({ connection: null, db: null, status: 'idle' });
            },

            // Setters for Card Tab Preferences
            setSourcesTab: (tab: string) => set({ sourcesTab: tab }),
            setPagesTab: (tab: string) => set({ pagesTab: tab }),
            setRegionsTab: (tab: string) => set({ regionsTab: tab }),
            setDevicesTab: (tab: string) => set({ devicesTab: tab }),
            setEventsTab: (tab: string) => set({ eventsTab: tab }),

            // --- Segment Management Actions ---
            addSegment: (segment: Segment) => {
                const currentSegments = get().segments;
                if (!currentSegments.some(s => s.type === segment.type && s.value === segment.value)) {
                    console.log("Adding segment:", segment);
                    set(state => ({ segments: [...state.segments, segment] }));
                    get().runAggregations();
                } else {
                     console.log("Segment already exists:", segment);
                }
            },
            removeSegment: (segmentToRemove: Segment) => {
                console.log("Removing segment:", segmentToRemove);
                set(state => ({ segments: state.segments.filter(s => !(s.type === segmentToRemove.type && s.value === segmentToRemove.value)) }));
                get().runAggregations();
            },
            clearSegments: () => {
                 console.log("Clearing all segments.");
                 set({ segments: [] });
                 get().runAggregations();
            },
        }),
        {
            name: 'analytics-store-preferences',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                // Persist date range as ISO strings
                selectedRange: state.selectedRange
                    ? { from: state.selectedRange.from?.toISOString(), to: state.selectedRange.to?.toISOString() }
                    : undefined,
                selectedPropertyKey: state.selectedPropertyKey,
                sourcesTab: state.sourcesTab,
                pagesTab: state.pagesTab,
                regionsTab: state.regionsTab,
                devicesTab: state.devicesTab,
                eventsTab: state.eventsTab,
                selectedSiteId: state.selectedSiteId, // Persist selected site
                // Do not persist sites list, fetch fresh on load
            }),
            // Rehydrate persisted dates from ISO strings
            onRehydrateStorage: () => { // Changed signature
                console.log("Rehydrating state...");
                return (state, error) => {
                    if (error) {
                        console.error("Failed to rehydrate state:", error);
                    }
                    if (state?.selectedRange?.from && state.selectedRange.to) {
                        try {
                            const fromDate = parseISO(state.selectedRange.from as unknown as string); // Cast to string first
                            const toDate = parseISO(state.selectedRange.to as unknown as string); // Cast to string first
                            if (isValid(fromDate) && isValid(toDate)) {
                                state.selectedRange = { from: fromDate, to: toDate };
                                console.log("Rehydrated date range:", state.selectedRange);
                            } else {
                                throw new Error("Invalid date string parsed");
                            }
                        } catch (dateError) {
                             console.error("Error parsing persisted dates:", dateError);
                             // Fallback to default if parsing fails
                             state.selectedRange = {
                                from: subDays(startOfDay(new Date()), 6),
                                to: endOfDay(new Date()),
                             };
                        }
                    } else {
                         // Set default if persisted range is incomplete or missing
                         if (state) { // Ensure state exists before modifying
                            state.selectedRange = {
                               from: subDays(startOfDay(new Date()), 6),
                               to: endOfDay(new Date()),
                            };
                            console.log("Setting default date range during rehydration.");
                         }
                    }
                };
            }
        }
    )
);