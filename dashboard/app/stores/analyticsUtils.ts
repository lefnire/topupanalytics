import * as arrow from 'apache-arrow';
import { type CardDataItem, type SankeyData, type SankeyLink, type SankeyNode } from './analyticsTypes';

// --- Constants ---
// Moved from analyticsStore.ts as they are used by buildSankeyData
const SANKEY_MIN_TRANSITION_COUNT = 3; // Minimum transitions for a link to appear
const SANKEY_MAX_DISPLAY_LINKS = 75;   // Max links processed/displayed in the chart

/**
 * Converts an Apache Arrow Table to an array of JavaScript objects.
 * Handles BigInt conversion safely.
 * @param table The Arrow Table.
 * @returns An array of objects, or an empty array if the table is null or empty.
 */
export const arrowTableToObjects = <T extends Record<string, any>>(table: arrow.Table | null): T[] => {
    if (!table || table.numRows === 0) return [];
    const objects: T[] = [];
    for (let i = 0; i < table.numRows; i++) {
        const row = table.get(i);
        if (row) {
            const obj: Record<string, any> = {};
            for (const field of table.schema.fields) {
                const value = row[field.name];
                // Safely convert BigInt to Number if possible, otherwise keep as string
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

/**
 * Extracts the first row from an Apache Arrow Table as a JavaScript object.
 * @param table The Arrow Table.
 * @returns The first row as an object, or undefined if the table is null or empty.
 */
export const firstRow = <T extends Record<string, any>>(table: arrow.Table | null): T | undefined => arrowTableToObjects<T>(table)[0];

/**
 * Formats a duration given in seconds into a human-readable string (e.g., "1m 30s", "45s").
 * @param totalSeconds The duration in seconds.
 * @returns A formatted string, or 'N/A' if the input is invalid.
 */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return 'N/A';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  if (seconds > 0) return `${seconds}s`;
  return '0s';
}

/**
 * Filters and maps rows from a combined aggregation result into CardDataItem format for a specific type.
 * @param rows The array of rows, each containing a 'type' property.
 * @param type The type to filter by.
 * @returns An array of CardDataItem objects for the specified type.
 */
export const toCards = <T extends { name: string; value: number; percentage?: number }>(rows: (T & { type: string })[], type: string): CardDataItem[] =>
   rows.filter(r => r.type === type).map(({ name, value, percentage }) => ({ name, value, percentage }));


/**
 * Transforms raw link data from SQL into the structure required for the Sankey chart.
 * Filters links based on minimum transition count and limits the number of displayed links.
 * @param rawLinks Array of objects with source_node, target_node, and value.
 * @returns SankeyData object with nodes and links.
 */
export function buildSankeyData(rawLinks: { source_node: string; target_node: string; value: number }[]): SankeyData {
    if (!rawLinks?.length) return { nodes: [], links: [] };

    // Filter links based on minimum count and ensure source/target are different
    const preliminaryLinks: SankeyLink[] = rawLinks
        .filter(r => r.source_node && r.target_node && r.source_node !== r.target_node && r.value >= SANKEY_MIN_TRANSITION_COUNT)
        .map(({ source_node, target_node, value }) => ({ source: source_node, target: target_node, value }));

    // Sort by value descending to keep the most significant links
    preliminaryLinks.sort((a, b) => b.value - a.value);

    // Limit the number of links displayed
    const links = preliminaryLinks.slice(0, SANKEY_MAX_DISPLAY_LINKS);

    // Extract unique nodes from the filtered links
    const nodesSet = new Set<string>();
    links.forEach(({ source, target }) => {
        nodesSet.add(source);
        nodesSet.add(target);
    });

    // Create node objects, cleaning up labels by removing step index
    const nodes: SankeyNode[] = Array.from(nodesSet).map(id => ({
        id,
        label: id.replace(/ #\d+$/, '') // Clean label
    }));

    return { nodes, links };
}