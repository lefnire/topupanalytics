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
            // Special handling: Map channel names back to complex DB conditions
            const lowerValue = String(value).toLowerCase();
             if (lowerValue === 'direct') return "COALESCE(referer_domain, '$direct', 'Unknown') = '$direct'";
             if (lowerValue === 'organic search') return `LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) IN ('google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu', 'google.com', 'google.co.uk', 'google.com.hk', 'yandex.ru', 'search.brave.com', 'perplexity.ai')`;
             if (lowerValue === 'social') return `LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) IN ('facebook.com', 't.co', 'twitter.com', 'linkedin.com', 'instagram.com', 'pinterest.com', 'reddit.com', 'com.reddit.frontpage', 'old.reddit.com', 'youtube.com', 'm.youtube.com')`;
             if (lowerValue === 'email') return `(utm_medium = 'email' OR LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) IN ('mail.google.com', 'com.google.android.gm'))`;
             if (lowerValue === 'paid search') return `utm_medium IN ('cpc', 'ppc')`;
             if (lowerValue === 'referral') return `(COALESCE(referer_domain, '$direct', 'Unknown') IS NOT NULL AND LOWER(COALESCE(referer_domain, '$direct', 'Unknown')) NOT IN ('$direct', 'unknown', 'google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'baidu', 'facebook.com', 't.co', 'twitter.com', 'linkedin.com', 'instagram.com', 'pinterest.com', 'reddit.com', 'mail.google.com', 'com.google.android.gm', 'com.reddit.frontpage', 'old.reddit.com', 'youtube.com', 'm.youtube.com', 'google.com', 'google.co.uk', 'google.com.hk', 'yandex.ru', 'search.brave.com', 'perplexity.ai') AND utm_medium NOT IN ('cpc', 'ppc', 'email'))`;
             return `COALESCE(referer_domain, '$direct', 'Unknown') = 'Unknown'`; // Default/Unknown
        } else if (segment.type === 'referer_domain') {
             // Special handling: strip www. from DB value for comparison, handle '$direct'
             if (value === '$direct') {
                 return `COALESCE(referer_domain, '$direct', 'Unknown') = '$direct'`;
             } else {
                 // Need to double-escape the backslash in the regex string for SQL
                 return `regexp_replace(COALESCE(referer_domain, '$direct', 'Unknown'), '^www\\\\.', '') = ${quotedValue}`;
             }
        } else if (segment.type === 'source') {
            // Special handling: source is derived like in the sourcesQuery aggregation
            const sourceDerivation = `CASE WHEN COALESCE(referer_domain, '$direct', 'Unknown') = '$direct' THEN '$direct' ELSE regexp_replace(COALESCE(referer_domain, '$direct', 'Unknown'), '^www\\\\.', '') END`;
            return `${sourceDerivation} = ${quotedValue}`;
        } else {
            // Default: simple equality check for other columns assumed to exist directly on the view
            return `${column} = ${quotedValue}`;
        }
    });

    return `WHERE ${conditions.join(' AND ')}`;
};


// --- Aggregation Runners ---

/**
 * Runs the main set of aggregations (stats, chart, sources, pages, regions, devices, events, custom keys).
 * @param connection The DuckDB connection.
 * @param selectedRange The selected date range.
 * @param segments The active segments.
 * @returns A promise resolving to the AggregatedData object.
 */
export const runAggregations = async (
    connection: duckdb.AsyncDuckDBConnection,
    selectedRange: DateRange,
    segments: Segment[]
): Promise<AggregatedData> => {
    if (!connection || !selectedRange?.from || !selectedRange?.to) {
        throw new Error("Invalid connection or date range for aggregation.");
    }

    console.log("Running aggregations...");
    const whereClause = generateWhereClause(segments);
    console.log("Aggregating with WHERE clause:", whereClause);

    try {
        // Stats Query
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
                           WHEN referrer_lower IS NOT NULL AND referrer_lower != '$direct' THEN 'Referral'
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
                       FIRST(CASE WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL THEN screen_width::VARCHAR || 'x' || screen_height::VARCHAR ELSE 'Unknown' END) as screen_size
                FROM FilteredAnalytics GROUP BY session_id
            ),
            TotalVisitors AS ( SELECT COUNT(*) as total FROM VisitorCounts ),
            BrowserCounts AS ( SELECT browser AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name ),
            OsCounts AS ( SELECT os AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name ),
            ScreenSizeCounts AS ( SELECT screen_size AS name, COUNT (*) AS value FROM VisitorCounts GROUP BY name )
            SELECT 'browsers' as type, BC.name, BC.value, (BC.value::DOUBLE / TV.total) * 100 AS percentage FROM BrowserCounts BC, TotalVisitors TV WHERE BC.value > 0
            UNION ALL SELECT 'os' as type, OC.name, OC.value, (OC.value::DOUBLE / TV.total) * 100 AS percentage FROM OsCounts OC, TotalVisitors TV WHERE OC.value > 0
            UNION ALL SELECT 'screenSizes' as type, SC.name, SC.value, (SC.value::DOUBLE / TV.total) * 100 AS percentage FROM ScreenSizeCounts SC, TotalVisitors TV WHERE SC.value > 0 AND SC.name != 'Unknown'
            ORDER BY type, value DESC LIMIT 300;
        `;
        const devicesPromise = connection.query(devicesQuery).then(result => {
            const rows = arrowTableToObjects<{ type: string; name: string; value: number; percentage: number }>(result);
            return { browsers: toCards(rows, 'browsers'), os: toCards(rows, 'os'), screenSizes: toCards(rows, 'screenSizes') };
        });

        // Events Query
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

        const aggregatedData: AggregatedData = {
            stats, chartData, eventsData, sources, pages, regions, devices,
            customProperties: { availableKeys, aggregatedValues: null } // Initialize aggregatedValues as null
        };

        console.log("Aggregation complete.");
        return aggregatedData;

    } catch (aggregationError: any) {
        console.error("Error during data aggregation:", aggregationError);
        throw aggregationError; // Re-throw to be handled by the store
    }
};

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