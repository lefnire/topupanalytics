import * as duckdb from '@duckdb/duckdb-wasm';
import * as arrow from 'apache-arrow';
import { type DateRange } from 'react-day-picker';
import {
    type Segment,
    type AggregatedData,
    type CardDataItem,
    type ChartDataPoint,
    type SankeyData,
    type Stats
} from './analyticsTypes';
import { arrowTableToObjects, firstRow, formatDuration, toCards, buildSankeyData } from './analyticsUtils';
// Removed incorrect import: import { type AnalyticsDataSchema } from './analyticsTypes';

// --- Constants ---
// Moved from analyticsStore.ts as they are used by runSankeyAggregation
const SANKEY_SQL_LINK_LIMIT = 200;     // Max links fetched from SQL

// --- SQL Helper Functions ---

/**
 * Maps a schema type string (from API) to a DuckDB SQL type string.
 * @param schemaType The schema type string.
 * @returns The corresponding DuckDB type string.
 */
export const mapSchemaToDuckDBType = (schemaType: string): string => {
  switch (schemaType.toLowerCase()) {
    case 'string':
    case 'map<string,string>': return 'VARCHAR';
    case 'timestamp': return 'TIMESTAMP';
    default:
      console.warn(`Unknown schema type "${schemaType}", defaulting to VARCHAR.`);
      return 'VARCHAR';
  }
};

/**
 * Generates the SQL for creating a table based on a schema.
 * Includes DROP TABLE IF EXISTS.
 * @param tableName The name of the table to create.
 * @param schema The schema definition.
 * @returns The CREATE TABLE SQL string.
 */
export const generateCreateTableSQL = (tableName: string, schema: { name: string; type: string }[]): string => {
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

/**
 * Generates the WHERE clause for SQL queries based on active segments.
 * Handles special cases for custom properties, screen size, channels, and referer domains.
 * @param segments An array of active Segment objects.
 * @returns The generated WHERE clause string (e.g., "WHERE column = 'value' AND ...").
 */
export const generateWhereClause = (segments: Segment[]): string => {
    if (segments.length === 0) return 'WHERE 1=1'; // Return a clause that always evaluates to true if no segments

    const conditions = segments.map(segment => {
        const column = segment.dbColumn || `\"${segment.type}\"`; // Use dbColumn if provided, else derive from type
        let value = segment.dbValue !== undefined ? segment.dbValue : segment.value; // Use dbValue if provided
        const quotedValue = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : value; // Quote strings and escape single quotes

        if (segment.type.startsWith('custom:')) {
            // Handle custom properties stored in a JSON column
            const propKey = segment.type.split(':')[1].replace(/[^a-zA-Z0-9_]/g, ''); // Sanitize key
            return `json_extract_string(properties, '$.${propKey}') = ${quotedValue}`;
        } else if (segment.type === 'screen_size') {
             // Special handling: screen size is derived from width and height columns
             return `(screen_width::VARCHAR || 'x' || screen_height::VARCHAR) = ${quotedValue}`;
        } else if (segment.type === 'channel') {
            // Channel is now a pre-calculated column
            return `channel = ${quotedValue}`;
        } else if (segment.type === 'referer_domain') {
             // Special handling: strip www. from DB value for comparison, handle '$direct'
             if (value === '$direct') {
                 return `COALESCE(referer_domain, '$direct', 'Unknown') = '$direct'`;
             } else {
                 // Need to double-escape the backslash in the regex string for SQL
                 return `regexp_replace(COALESCE(referer_domain, '$direct', 'Unknown'), '^www\\.', '') = ${quotedValue}`;
             }
        } else if (segment.type === 'source') {
            // Source is now a pre-calculated column
            return `source = ${quotedValue}`;
        } else {
            // Default: simple equality check for other columns assumed to exist directly on the view
            return `${column} = ${quotedValue}`;
        }
    });

    return `WHERE ${conditions.join(' AND ')}`;
};

// ============================================================================
// Data Loading and View Creation Functions (Moved from analyticsSqlStore)
// ============================================================================

/**
 * Loads fetched initial events and subsequent events data into DuckDB tables.
 * Handles table creation (dropping existing), data insertion within a transaction,
 * and file buffer management.
 *
 * @param db The DuckDB instance.
 * @param connection The DuckDB connection.
 * @param initialEvents Array of initial event objects.
 * @param events Array of subsequent event objects.
 * @param commonSchema Schema definition for columns present in both initial and subsequent events.
 * @param initialOnlySchema Schema definition for columns present only in initial events.
 * @returns Promise resolving to true if successful, false otherwise.
 */
export const loadDataIntoTables = async (
  db: duckdb.AsyncDuckDB,
  connection: duckdb.AsyncDuckDBConnection,
  initialEvents: any[],
  events: any[],
  commonSchema: { name: string; type: string }[], // Use inline type
  initialOnlySchema: { name: string; type: string }[] // Use inline type
): Promise<boolean> => {
  const initialEventsFileName = 'initial_events.json';
  const eventsFileName = 'events.json';
  let transactionSuccessful = false;

  try {
    // 1. Register Data Buffers
    const initialEventsBuffer = new TextEncoder().encode(JSON.stringify(initialEvents));
    const eventsBuffer = new TextEncoder().encode(JSON.stringify(events));
    await Promise.all([
      db.registerFileBuffer(initialEventsFileName, initialEventsBuffer),
      db.registerFileBuffer(eventsFileName, eventsBuffer)
    ]);
    console.log(`SQL Util: Registered ${initialEventsFileName} and ${eventsFileName}`);

    // 2. Prepare SQL
    const fullInitialSchema = [...commonSchema, ...initialOnlySchema];
    const createInitialTableSql = generateCreateTableSQL('initial_events', fullInitialSchema); // generateCreateTableSQL already includes DROP
    const createEventsTableSql = generateCreateTableSQL('events', commonSchema); // generateCreateTableSQL already includes DROP

    const readInitialJsonColumnsSql = `{${fullInitialSchema.map(c => `"${c.name}": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`;
    const readEventsJsonColumnsSql = `{${commonSchema.map(c => `"${c.name}": '${mapSchemaToDuckDBType(c.type)}'`).join(', ')}}`;

    const insertInitialSql = `INSERT INTO initial_events SELECT * FROM read_json('${initialEventsFileName}', auto_detect=false, columns=${readInitialJsonColumnsSql});`;
    const insertEventsSql = `INSERT INTO events SELECT * FROM read_json('${eventsFileName}', auto_detect=false, columns=${readEventsJsonColumnsSql});`;

    // 3. Execute Transaction
    await connection.query('BEGIN TRANSACTION;');
    try {
      // Drop handled by generateCreateTableSQL
      // Create new tables
      await Promise.all([
          connection.query(createInitialTableSql),
          connection.query(createEventsTableSql)
      ]);

      // Insert data into tables
      const insertPromises = [];
      if (initialEvents.length > 0) insertPromises.push(connection.query(insertInitialSql));
      if (events.length > 0) insertPromises.push(connection.query(insertEventsSql));
      if (insertPromises.length > 0) await Promise.all(insertPromises);

      // Commit Transaction
      await connection.query('COMMIT;');
      transactionSuccessful = true;
      console.log('SQL Util: Table data transaction committed successfully.');

    } catch (txError) {
      console.error('SQL Util: Table data transaction failed, rolling back...', txError);
      await connection.query('ROLLBACK;');
      throw txError; // Re-throw original error
    }

  } catch (error) {
    console.error("SQL Util: Error during data loading into tables:", error);
    // Ensure transactionSuccessful remains false or is set to false
    transactionSuccessful = false;
    // Re-throw the error to be handled by the caller
    throw error;
  } finally {
    // 4. Drop file buffers regardless of success or failure (after transaction attempt)
    try {
      await Promise.all([
        db.dropFile(initialEventsFileName).catch(e => console.warn(`SQL Util: Failed to drop ${initialEventsFileName}:`, e)),
        db.dropFile(eventsFileName).catch(e => console.warn(`SQL Util: Failed to drop ${eventsFileName}:`, e))
      ]);
      console.log(`SQL Util: Dropped file buffers ${initialEventsFileName} and ${eventsFileName}`);
    } catch (dropError) {
       console.error('SQL Util: Error dropping files:', dropError);
    }
  }
  return transactionSuccessful;
};

/**
 * Creates or replaces the main 'analytics' view in DuckDB.
 * This view joins initial and subsequent events, forward-fills static data,
 * and calculates derived columns like channel and source.
 *
 * @param connection The DuckDB connection.
 * @param commonSchema Schema definition for columns present in both initial and subsequent events.
 * @param initialOnlySchema Schema definition for columns present only in initial events.
 * @returns Promise resolving when the view is created.
 */
export const createOrReplaceAnalyticsView = async (
   connection: duckdb.AsyncDuckDBConnection,
   commonSchema: { name: string; type: string }[], // Use inline type
   initialOnlySchema: { name: string; type: string }[] // Use inline type
): Promise<void> => {
    const fullInitialSchema = [...commonSchema, ...initialOnlySchema];
    const eventSpecificCols = ['event', 'pathname', 'timestamp', 'properties']; // Columns specific to 'events' table or derived later
    const staticCols = fullInitialSchema.filter(col => !eventSpecificCols.includes(col.name)).map(col => col.name);

    // Ensure session_id exists before partitioning by it, fallback needed
    const partitionKey = staticCols.includes('session_id') ? 'session_id' : (staticCols.length > 0 ? staticCols[0] : null); // Fallback if no session_id

    const staticColFirstValues = staticCols.map(col =>
      partitionKey
        ? `FIRST_VALUE(d."${col}") OVER (PARTITION BY d."${partitionKey}" ORDER BY d."timestamp") AS "${col}"`
        : `d."${col}"` // If no partition key, just select the column directly (shouldn't happen with session_id)
    ).join(',\n                 ');

    const nullPlaceholders = initialOnlySchema.map(c => `NULL AS "${c.name}"`).join(', ');
    const commonSelectColsQuoted = commonSchema.map(c => `"${c.name}"`);
    const allColsSelectString = [...commonSelectColsQuoted, ...initialOnlySchema.map(c => `"${c.name}"`)].join(', ');

    const createAnalyticsViewSql = `
        CREATE OR REPLACE VIEW analytics AS
        WITH base AS (
            SELECT ${allColsSelectString} FROM initial_events
            UNION ALL
            SELECT ${commonSelectColsQuoted.join(', ')}${initialOnlySchema.length > 0 ? ', ' + nullPlaceholders : ''} FROM events
        ),
        -- Pre-calculate channel and source for easier filtering
        derived AS (
            SELECT *,
                   LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) AS referrer_lower,
                   CASE
                       WHEN utm_medium = 'cpc' OR utm_medium = 'ppc' THEN 'Paid Search'
                       WHEN utm_medium = 'email' OR list_contains(['mail.google.com', 'com.google.android.gm'], LOWER(COALESCE(referer_domain, '$direct', 'Unknown'))) THEN 'Email'
                       WHEN utm_medium = 'social' OR list_contains([
                            'facebook', 'twitter', 'linkedin', 'instagram', 'pinterest', 'reddit', 't.co',
                            'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'pinterest.com', 'reddit.com',
                            'com.reddit.frontpage', 'old.reddit.com', 'youtube.com', 'm.youtube.com'
                           ], LOWER(COALESCE(referer_domain, '$direct', 'Unknown'))) THEN 'Social'
                       WHEN list_contains([
                            'google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu',
                            'google.com', 'google.co.uk', 'google.com.hk', 'yandex.ru', 'search.brave.com', 'perplexity.ai'
                           ], LOWER(COALESCE(referer_domain, '$direct', 'Unknown'))) THEN 'Organic Search'
                       WHEN LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) = '$direct' THEN 'Direct'
                       WHEN LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) = 'Unknown' THEN 'Unknown'
                       WHEN COALESCE(referer_domain, '$direct', 'Unknown') IS NOT NULL AND LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) != '$direct' THEN 'Referral'
                       ELSE 'Unknown'
                   END AS channel,
                   CASE
                       WHEN COALESCE(referer_domain, '$direct', 'Unknown') = '$direct' THEN '$direct'
                       ELSE regexp_replace(COALESCE(referer_domain, '$direct', 'Unknown'), '^www\\\\.', '') -- Corrected: Double escape for SQL string literal
                   END AS source
            FROM base
        )
        -- Select base event columns, forward-filled static columns, and derived channel/source
        SELECT d."event", d."pathname", d."timestamp", d."properties", d."channel", d."source"${staticColFirstValues ? ', ' + staticColFirstValues : ''}
        FROM derived d;
    `;

    try {
        // DROP VIEW IF EXISTS is handled by CREATE OR REPLACE VIEW
        await connection.query(createAnalyticsViewSql);
        const countResult = await connection.query(`SELECT COUNT(*) AS count FROM analytics`); // Verify view exists
        console.log(`SQL Util: Analytics view created/recreated successfully with ${firstRow<{ count: number }>(countResult)?.count ?? 0} events.`);
    } catch (viewError: any) {
        console.error('SQL Util: Failed to create analytics view:', viewError);
        throw viewError; // Re-throw to be handled by the caller
    }
};

// --- Aggregation Runners ---

/**
 * Runs the main set of aggregations (stats, chart, sources, pages, regions, devices, events, custom keys).
 * @param connection The DuckDB connection.
 * @param selectedRange The selected date range.
 * @param segments The active segments.
 * Runs the essential base aggregations (stats, chart, available keys) and the aggregations for the initially selected tabs.
 * @param connection The DuckDB connection.
 * @param selectedRange The selected date range (needed for chart).
 * @param segments The active segments.
 * @param views An object containing the initially selected view/tab for each category.
 * @returns A promise resolving to the AggregatedData object containing base data and initial tab data.
 */
export const runAggregations = async (
    connection: duckdb.AsyncDuckDBConnection,
    selectedRange: DateRange,
    segments: Segment[],
    views: {
        sourcesView: string;
        pagesView: string;
        regionsView: string;
        devicesView: string;
        eventsView: string; // Assuming 'events' is the only view for now
    }
): Promise<Partial<AggregatedData>> => { // Return Partial as only initial tabs are loaded
    if (!connection || !selectedRange?.from || !selectedRange?.to) {
        throw new Error("Invalid connection or date range for aggregation.");
    }

    console.log("Running initial aggregations for views:", views);
    const whereClause = generateWhereClause(segments);
    console.log("Aggregating with WHERE clause:", whereClause);

    try {
        // --- Base Aggregations (Always Run) ---

        // Stats Query
        const statsQuery = `
            WITH SessionPageViews AS (
                SELECT session_id, COUNT(*) FILTER (WHERE event = 'page_view') as page_view_count
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
            ), MedianDurationStat AS (
                 SELECT COALESCE(MEDIAN(duration_ms) / 1000.0, 0) AS median_duration_seconds FROM SessionDurations
            )
            SELECT tv.uniqueVisitors, tp.totalPageviews, mds.median_duration_seconds,
                   CASE WHEN tv.uniqueVisitors > 0 THEN (bs.bouncedSessionsCount::DOUBLE / tv.uniqueVisitors) * 100.0 ELSE 0 END AS bounce_rate_percentage
            FROM TotalVisitors tv, TotalPageviews tp, BouncedSessions bs, MedianDurationStat mds;
        `;
        const statsPromise = connection.query(statsQuery).then(result => {
            const res = firstRow<{ uniqueVisitors: number; totalPageviews: number; median_duration_seconds: number | null; bounce_rate_percentage: number | null; }>(result);
            if (!res) return { totalVisits: 0, totalPageviews: 0, uniqueVisitors: 0, viewsPerVisit: 'N/A', visitDuration: 'N/A', bounceRate: 'N/A' };
            const { uniqueVisitors: totalVisits, totalPageviews, median_duration_seconds, bounce_rate_percentage } = res;
            return {
                totalVisits, totalPageviews, uniqueVisitors: totalVisits,
                viewsPerVisit: totalVisits ? (totalPageviews / totalVisits).toFixed(2) : 'N/A',
                visitDuration: formatDuration(median_duration_seconds),
                bounceRate: bounce_rate_percentage !== null ? `${bounce_rate_percentage.toFixed(1)}%` : 'N/A',
            };
        });

        // Chart Data Query
        const daysDiff = selectedRange.to.getTime() - selectedRange.from.getTime();
        const oneDayMs = 24 * 60 * 60 * 1000;
        const timeFormat = daysDiff <= oneDayMs ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
        const chartDataQuery = `
            SELECT strftime(timestamp, '${timeFormat}') AS date, COUNT(*) AS views
            FROM analytics ${whereClause} AND event = 'page_view'
            GROUP BY date ORDER BY date;
        `;
        const chartDataPromise = connection.query(chartDataQuery).then(arrowTableToObjects<ChartDataPoint>);

        // Available Custom Property Keys Query
        const keysQuery = `
            SELECT DISTINCT unnest(json_keys(json(properties))) AS key
            FROM analytics WHERE json_valid(properties) ORDER BY key;
        `;
        const keysPromise = connection.query(keysQuery).then(result => arrowTableToObjects<{ key: string }>(result).map(row => row.key))
            .catch(err => { console.warn("Could not get custom property keys:", err); return []; });


        // --- Initial Tab Aggregations (Run based on views argument) ---
        const sourcesPromise = runSourcesAggregationSql(connection, segments, views.sourcesView);
        const pagesPromise = runPagesAggregationSql(connection, segments, views.pagesView);
        const regionsPromise = runRegionsAggregationSql(connection, segments, views.regionsView);
        const devicesPromise = runDevicesAggregationSql(connection, segments, views.devicesView);
        const eventsPromise = runEventsAggregationSql(connection, segments, views.eventsView); // Assuming 'events' is the only view type for now


        // --- Execute & Combine ---
        const [stats, chartData, availableKeys, sources, pages, regions, devices, eventsData] = await Promise.all([
            statsPromise, chartDataPromise, keysPromise,
            sourcesPromise, pagesPromise, regionsPromise, devicesPromise, eventsPromise
        ]);

        // Construct the initial aggregated data object
        // Note: sources, pages, etc., will only contain data for the *initial* view
        const aggregatedData: Partial<AggregatedData> = {
            stats,
            chartData,
            eventsData, // This comes directly from runEventsAggregationSql
            sources,    // Result from runSourcesAggregationSql
            pages,      // Result from runPagesAggregationSql
            regions,    // Result from runRegionsAggregationSql
            devices,    // Result from runDevicesAggregationSql
            customProperties: { availableKeys, aggregatedValues: null } // Initialize aggregatedValues as null
        };

        console.log("Initial aggregation complete.");
        return aggregatedData;

    } catch (aggregationError: any) {
        console.error("Error during initial data aggregation:", aggregationError);
        throw aggregationError; // Re-throw to be handled by the store
    }
};


// ============================================================================
// Specific Aggregation Functions (Called by Routers or runSpecificAggregation)
// ============================================================================

// --- Helper Function for Simple Aggregations ---

/**
 * Internal helper to run common aggregation patterns returning CardDataItem[].
 * SELECT {selectNameExpr} AS name, {selectValueExpr} AS value
 * FROM analytics
 * WHERE {segments} AND {additionalWhere}
 * GROUP BY name
 * HAVING value > 0 ORDER BY {orderBy} LIMIT {limit}
 */
const _runSimpleAggregation = async (
  conn: duckdb.AsyncDuckDBConnection,
  segments: Segment[],
  selectNameExpr: string, // Expression for the 'name' column
  selectValueExpr: string, // Expression for the 'value' column
  additionalWhere: string = '1=1', // Additional WHERE conditions beyond segments
  orderBy: string = 'value DESC',
  limit: number = 100
): Promise<CardDataItem[]> => {
  const whereClause = generateWhereClause(segments);
  const finalWhere = `${whereClause} AND (${additionalWhere})`; // Combine segment and additional filters

  // Note: We directly use the expressions in SELECT and GROUP BY the alias 'name'
  // This works in DuckDB and simplifies the call signature.
  const query = `
    SELECT
      ${selectNameExpr} AS name,
      ${selectValueExpr} AS value
    FROM analytics
    ${finalWhere}
    GROUP BY name
    HAVING value > 0
    ORDER BY ${orderBy}
    LIMIT ${limit};
  `;
  // console.log(`_runSimpleAggregation Query for name='${selectNameExpr}':\n${query}`); // Debug logging
  return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};


// --- Sources ---
export const runSourcesChannelsSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    return _runSimpleAggregation(conn, segments, 'channel', 'COUNT(DISTINCT session_id)');
};

export const runSourcesSourcesSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    return _runSimpleAggregation(conn, segments, 'source', 'COUNT(DISTINCT session_id)');
};

export const runSourcesCampaignsSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    return _runSimpleAggregation(
        conn,
        segments,
        "COALESCE(utm_campaign, '(not set)')", // selectNameExpr
        'COUNT(DISTINCT session_id)',         // selectValueExpr
        'utm_campaign IS NOT NULL'            // additionalWhere
    );
};

// --- Pages ---
export const runPagesTopPagesSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    // This one is slightly different as it counts events, not sessions, and filters events
    return _runSimpleAggregation(
        conn,
        segments,
        'pathname',                                                               // selectNameExpr
        'COUNT(*)',                                                               // selectValueExpr
        "event = 'page_view' AND pathname IS NOT NULL AND trim(pathname) != ''"   // additionalWhere
    );
};

// NOTE: Entry/Exit pages use window functions and are too complex for _runSimpleAggregation
export const runPagesEntryPagesSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    const whereClause = generateWhereClause(segments);
    const query = `
        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
        PageViews AS ( SELECT session_id, pathname, timestamp FROM FilteredAnalytics WHERE event = 'page_view' AND pathname IS NOT NULL AND trim(pathname) != '' ),
        RankedPageViews AS ( SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp ASC) as rn_asc FROM PageViews )
        SELECT pathname AS name, COUNT (*) AS value FROM RankedPageViews WHERE rn_asc = 1 GROUP BY pathname HAVING value > 0 ORDER BY value DESC LIMIT 100;
    `;
    return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};

export const runPagesExitPagesSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    const whereClause = generateWhereClause(segments);
    const query = `
        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
        PageViews AS ( SELECT session_id, pathname, timestamp FROM FilteredAnalytics WHERE event = 'page_view' AND pathname IS NOT NULL AND trim(pathname) != '' ),
        RankedPageViews AS ( SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp DESC) as rn_desc FROM PageViews )
        SELECT pathname AS name, COUNT (*) AS value FROM RankedPageViews WHERE rn_desc = 1 GROUP BY pathname HAVING value > 0 ORDER BY value DESC LIMIT 100;
    `;
    return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};

// --- Regions ---
export const runRegionsCountriesSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    return _runSimpleAggregation(conn, segments, "COALESCE(country, 'Unknown')", 'COUNT(DISTINCT session_id)');
};

export const runRegionsRegionsSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    return _runSimpleAggregation(
        conn,
        segments,
        "COALESCE(region, 'Unknown')", // selectNameExpr
        'COUNT(DISTINCT session_id)',  // selectValueExpr
        "region IS NOT NULL AND region != 'Unknown'" // additionalWhere (Filter out Unknown *before* grouping)
        // Note: The original query filtered *after* grouping (WHERE name != 'Unknown').
        // Filtering before grouping is generally more efficient and achieves the same result here.
    );
};

// --- Devices ---
// NOTE: Device aggregations calculate percentages and use FIRST(), making them unsuitable for _runSimpleAggregation
export const runDevicesBrowsersSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    const whereClause = generateWhereClause(segments);
    const query = `
        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
        VisitorCounts AS ( SELECT session_id, FIRST(COALESCE(browser, 'Unknown')) as browser FROM FilteredAnalytics GROUP BY session_id ),
        TotalVisitors AS ( SELECT COUNT(*) as total FROM VisitorCounts ),
        BrowserCounts AS ( SELECT browser AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name )
        SELECT BC.name, BC.value, (BC.value::DOUBLE / TV.total) * 100 AS percentage
        FROM BrowserCounts BC, TotalVisitors TV WHERE BC.value > 0 ORDER BY value DESC LIMIT 100;
    `;
    return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};

export const runDevicesOsSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    const whereClause = generateWhereClause(segments);
    const query = `
        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
        VisitorCounts AS ( SELECT session_id, FIRST(COALESCE(os, 'Unknown')) as os FROM FilteredAnalytics GROUP BY session_id ),
        TotalVisitors AS ( SELECT COUNT(*) as total FROM VisitorCounts ),
        OsCounts AS ( SELECT os AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name )
        SELECT OC.name, OC.value, (OC.value::DOUBLE / TV.total) * 100 AS percentage
        FROM OsCounts OC, TotalVisitors TV WHERE OC.value > 0 ORDER BY value DESC LIMIT 100;
    `;
    return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};

export const runDevicesScreenSizesSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    const whereClause = generateWhereClause(segments);
    const query = `
        WITH FilteredAnalytics AS ( SELECT * FROM analytics ${whereClause} ),
        VisitorCounts AS (
            SELECT session_id, FIRST(CASE WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL THEN screen_width::VARCHAR || 'x' || screen_height::VARCHAR ELSE 'Unknown' END) as screen_size
            FROM FilteredAnalytics GROUP BY session_id
        ),
        TotalVisitors AS ( SELECT COUNT(*) as total FROM VisitorCounts ),
        ScreenSizeCounts AS ( SELECT screen_size AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name )
        SELECT SC.name, SC.value, (SC.value::DOUBLE / TV.total) * 100 AS percentage
        FROM ScreenSizeCounts SC, TotalVisitors TV WHERE SC.value > 0 AND SC.name != 'Unknown' ORDER BY value DESC LIMIT 100;
    `;
    return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};

// --- Events ---
// NOTE: Event aggregation calculates percentages and counts total events, making it unsuitable for _runSimpleAggregation
export const runEventsEventsSql = async (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]): Promise<CardDataItem[]> => {
    const whereClause = generateWhereClause(segments);
    const query = `
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
    return conn.query(query).then(arrowTableToObjects<CardDataItem>);
};


// ============================================================================
// Aggregation Router Functions (Called by runAggregations or runSpecificAggregation)
// ============================================================================

// --- Sources Aggregation Map ---
const sourcesAggregationMap = new Map<string, (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]) => Promise<AggregatedData['sources']>>([
  ['channels', async (conn, segments) => ({ channels: await runSourcesChannelsSql(conn, segments), sources: [], campaigns: [] })],
  ['sources', async (conn, segments) => ({ channels: [], sources: await runSourcesSourcesSql(conn, segments), campaigns: [] })],
  ['campaigns', async (conn, segments) => ({ channels: [], sources: [], campaigns: await runSourcesCampaignsSql(conn, segments) })],
]);

export const runSourcesAggregationSql = async (
    conn: duckdb.AsyncDuckDBConnection,
    segments: Segment[],
    viewType: string
): Promise<AggregatedData['sources']> => {
    console.log(`Running sources aggregation for view: ${viewType}`);
    const executor = sourcesAggregationMap.get(viewType);
    if (executor) {
        return executor(conn, segments);
    } else {
        console.warn(`Unknown sources viewType: ${viewType}, defaulting to channels.`);
        // Default to channels if viewType is unknown
        const defaultExecutor = sourcesAggregationMap.get('channels');
        return defaultExecutor!(conn, segments); // Non-null assertion ok as 'channels' is guaranteed key
    }
};

// --- Pages Aggregation Map ---
const pagesAggregationMap = new Map<string, (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]) => Promise<AggregatedData['pages']>>([
  ['topPages', async (conn, segments) => ({ topPages: await runPagesTopPagesSql(conn, segments), entryPages: [], exitPages: [] })],
  ['entryPages', async (conn, segments) => ({ topPages: [], entryPages: await runPagesEntryPagesSql(conn, segments), exitPages: [] })],
  ['exitPages', async (conn, segments) => ({ topPages: [], entryPages: [], exitPages: await runPagesExitPagesSql(conn, segments) })],
]);

export const runPagesAggregationSql = async (
    conn: duckdb.AsyncDuckDBConnection,
    segments: Segment[],
    viewType: string
): Promise<AggregatedData['pages']> => {
    console.log(`Running pages aggregation for view: ${viewType}`);
    const executor = pagesAggregationMap.get(viewType);
    if (executor) {
        return executor(conn, segments);
    } else {
        console.warn(`Unknown pages viewType: ${viewType}, defaulting to topPages.`);
        const defaultExecutor = pagesAggregationMap.get('topPages');
        return defaultExecutor!(conn, segments); // Non-null assertion ok
    }
};

// --- Regions Aggregation Map ---
const regionsAggregationMap = new Map<string, (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]) => Promise<AggregatedData['regions']>>([
  ['countries', async (conn, segments) => ({ countries: await runRegionsCountriesSql(conn, segments), regions: [] })],
  ['regions', async (conn, segments) => ({ countries: [], regions: await runRegionsRegionsSql(conn, segments) })],
]);

export const runRegionsAggregationSql = async (
    conn: duckdb.AsyncDuckDBConnection,
    segments: Segment[],
    viewType: string
): Promise<AggregatedData['regions']> => {
    console.log(`Running regions aggregation for view: ${viewType}`);
    const executor = regionsAggregationMap.get(viewType);
    if (executor) {
        return executor(conn, segments);
    } else {
        console.warn(`Unknown regions viewType: ${viewType}, defaulting to countries.`);
        const defaultExecutor = regionsAggregationMap.get('countries');
        return defaultExecutor!(conn, segments); // Non-null assertion ok
    }
};

// --- Devices Aggregation Map ---
const devicesAggregationMap = new Map<string, (conn: duckdb.AsyncDuckDBConnection, segments: Segment[]) => Promise<AggregatedData['devices']>>([
  ['browsers', async (conn, segments) => ({ browsers: await runDevicesBrowsersSql(conn, segments), os: [], screenSizes: [] })],
  ['os', async (conn, segments) => ({ browsers: [], os: await runDevicesOsSql(conn, segments), screenSizes: [] })],
  ['screenSizes', async (conn, segments) => ({ browsers: [], os: [], screenSizes: await runDevicesScreenSizesSql(conn, segments) })],
]);

export const runDevicesAggregationSql = async (
    conn: duckdb.AsyncDuckDBConnection,
    segments: Segment[],
    viewType: string
): Promise<AggregatedData['devices']> => {
    console.log(`Running devices aggregation for view: ${viewType}`);
    const executor = devicesAggregationMap.get(viewType);
    if (executor) {
        return executor(conn, segments);
    } else {
        console.warn(`Unknown devices viewType: ${viewType}, defaulting to browsers.`);
        const defaultExecutor = devicesAggregationMap.get('browsers');
        return defaultExecutor!(conn, segments); // Non-null assertion ok
    }
};

// Assuming only 'events' view type for now
export const runEventsAggregationSql = async (
    conn: duckdb.AsyncDuckDBConnection,
    segments: Segment[],
    viewType: string // Keep signature consistent, even if unused for now
): Promise<AggregatedData['eventsData']> => {
    console.log(`Running events aggregation (view: ${viewType})`);
    // Currently only one event aggregation type exists
    return runEventsEventsSql(conn, segments);
};


// ============================================================================
// Other Aggregations (Custom Properties, Sankey) - Unchanged for Phase 2
// ============================================================================

/**
 * Runs aggregation for a specific custom property key.
 * @param connection The DuckDB connection.
 * @param key The custom property key to aggregate.
 * @param segments The active segments.
 * @returns A promise resolving to an array of CardDataItem for the custom property.
 */
export const runCustomPropertyAggregation = async (
    connection: duckdb.AsyncDuckDBConnection,
    key: string,
    segments: Segment[]
): Promise<CardDataItem[]> => {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, ''); // Sanitize key
    if (!connection || !safeKey) {
        console.warn("Skipping custom property aggregation - invalid connection or key.");
        return [];
    }

    const whereClause = generateWhereClause(segments);
    console.log(`Aggregating custom prop '${safeKey}' with WHERE: ${whereClause}`);

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
        console.log(`Custom property aggregation complete for key: ${key}.`);
        return results;
    } catch (error: any) {
        console.error(`Error aggregating properties for key ${safeKey}:`, error);
        throw error; // Re-throw to be handled by the store
    }
};

/**
 * Runs the Sankey diagram aggregation.
 * @param connection The DuckDB connection.
 * @param segments The active segments.
 * @returns A promise resolving to the SankeyData object.
 */
export const runSankeyAggregation = async (
    connection: duckdb.AsyncDuckDBConnection,
    segments: Segment[]
): Promise<SankeyData> => {
    if (!connection) {
        console.warn("Skipping Sankey aggregation - no connection.");
        return { nodes: [], links: [] };
    }

    console.log("Running Sankey aggregation...");
    const whereClause = generateWhereClause(segments);
    console.log("Sankey aggregating with WHERE clause:", whereClause);

    try {
        const sankeyQuery = `
            WITH MatchingSessions AS (
                SELECT DISTINCT session_id FROM analytics ${whereClause}
            ), SessionEvents AS (
                SELECT a.session_id, a.timestamp, a.event, a.pathname
                FROM analytics a JOIN MatchingSessions ms ON a.session_id = ms.session_id
            ), RawEvents AS (
                SELECT session_id, timestamp, CASE WHEN event = 'page_view' THEN '📃 ' || COALESCE(pathname, '[unknown]') ELSE '🖱️ ' || event END AS base_node
                FROM SessionEvents
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
            ORDER BY value DESC LIMIT ${SANKEY_SQL_LINK_LIMIT};
        `;

        const result = await connection.query(sankeyQuery);
        const rawLinksData = arrowTableToObjects<{ source_node: string; target_node: string; value: number }>(result);

        if (!rawLinksData || rawLinksData.length === 0) {
            console.warn("Sankey aggregation returned no links data.");
            return { nodes: [], links: [] };
        }

        const sankeyData = buildSankeyData(rawLinksData); // Use utility function
        console.log(`Sankey aggregation complete. Found ${sankeyData.nodes.length} nodes and ${sankeyData.links.length} links.`);
        return sankeyData;

    } catch (sankeyError: any) {
        console.error("Error during Sankey data aggregation:", sankeyError);
        throw sankeyError; // Re-throw to be handled by the store
    }
};