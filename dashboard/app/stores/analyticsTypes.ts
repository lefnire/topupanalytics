import { type DateRange } from 'react-day-picker';
import { type Site, type UserPreferences } from '../lib/api'; // Import Site and UserPreferences

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
export type AnalyticsStatus = 'idle' | 'initializing' | 'loading_data' | 'aggregating' | 'aggregating_tab' | 'error';

// Define Segment structure
export interface Segment {
    type: string;
    value: string | number;
    label: string;
    dbColumn?: string;
   dbValue?: string | number;
}

// Re-export imported types if needed elsewhere, though likely imported directly
export type { Site, UserPreferences };

// Define the shape of the state managed by Zustand
// Note: db and connection types are imported in the main store file
export interface AnalyticsStateBase {
    status: AnalyticsStatus;
    error: string | null;
    selectedRange: DateRange | undefined;
    aggregatedData: AggregatedData | null;
    selectedPropertyKey: string | null;
    sankeyData: SankeyData | null;
    isRefreshing: boolean;
    segments: Segment[];
    sites: Site[];
    selectedSiteId: string | null;
    userPreferences: UserPreferences | null;

    // Card Tab Preferences
    sourcesTab: string;
    pagesTab: string;
    regionsTab: string;
    devicesTab: string;
    eventsTab: string;
}