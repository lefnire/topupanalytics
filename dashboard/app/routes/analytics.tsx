import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense, memo } from 'react';
import { Navigate } from 'react-router'; // Import Navigate for redirection
import { useShallow } from 'zustand/shallow';
import { useAuth } from '../contexts/AuthContext'; // Import the auth hook
import { Button } from '../components/ui/button'; // Import Button for logout
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useStore, type AnalyticsState, type AggregatedData, type CardDataItem, type Segment } from '../stores/analyticsStore'; // Import Segment
import { type Site } from '../lib/api'; // Import Site type from lib/api
import {
 Select,
 SelectContent,
 SelectItem,
 SelectTrigger,
 SelectValue,
} from "../components/ui/select"; // Import Select components
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover"; // Import Popover
import { Calendar } from "../components/ui/calendar"; // Import Calendar
import { Calendar as CalendarIcon } from "lucide-react"; // Import Calendar icon
import { format, differenceInDays } from 'date-fns'; // Import date-fns functions
import { type DateRange } from 'react-day-picker'; // Import DateRange type
import { cn } from "../lib/utils"; // Import cn utility
import { useApiClient } from '../lib/api'; // Import useApiClient for Stripe calls
import { toast } from 'sonner'; // Import toast

// Remove direct import, use React.lazy instead
// import { SankeyCard } from './components/SankeyCard';

// --- Constants ---
const isServer = typeof window === 'undefined';

// --- Helper Functions ---
const formatNumber = (num: number) => num.toLocaleString();

// --- Specific Card Components (No changes needed here for now) ---

// BaseCard remains mostly the same for now, accepting data via props
interface CardProps {
  title: string;
  tabs: { key: string; label: string }[];
  data: Record<string, CardDataItem[]>; // CardDataItem is imported from store
  renderHeader?: (activeTab: string) => React.ReactNode;
  renderItem?: (item: CardDataItem, index: number, activeTab: string) => React.ReactNode; // CardDataItem is imported from store
  activeTab: string; // Now controlled from outside
  setActiveTab: (key: string) => void; // Setter function passed in
  onItemClick?: (segment: Segment) => void; // Changed: onItemClick now takes a Segment object directly
  generateSegmentForItem: (item: CardDataItem, activeTab: string) => Segment | null; // Added: Helper function to generate segment for an item
  cardId: string; // Add cardId to know the context
  loading?: boolean; // Keep loading prop for individual card control if needed
  error?: string | null; // Keep error prop
  noDataMessage?: string;
}

const BaseCard: React.FC<CardProps> = ({
  title,
  tabs,
  data,
  renderHeader,
  renderItem,
  activeTab, // Use prop
  setActiveTab, // Use prop
  onItemClick, // Use handler prop
  generateSegmentForItem, // New prop
  cardId, // Use cardId
  loading,
  error,
  noDataMessage
}) => {
  // Remove local state: const [activeTab, setActiveTab] = useState(initialTab || tabs[0]?.key || '');
  const currentData = data[activeTab] || [];

  // Optional: Add effect to reset if activeTab becomes invalid (e.g., due to data changes),
  // though the store should ideally handle valid states.
  useEffect(() => {
    const validTabs = tabs.map(t => t.key);
    if (!validTabs.includes(activeTab) && validTabs.length > 0) {
      // If the current activeTab from the store is not in the available tabs for this card,
      // reset it to the first available tab. This handles edge cases.
      setActiveTab(validTabs[0]);
    }
    // Depend only on tabs and the activeTab prop. setActiveTab is stable.
  }, [tabs, activeTab, setActiveTab]);


  // Make default list items clickable if onItemClick is provided
  const handleItemClickInternal = (item: CardDataItem) => {
    if (!onItemClick) return;
    const segment = generateSegmentForItem(item, activeTab); // Use helper to generate segment
    if (segment) {
      onItemClick(segment); // Pass the generated segment
    } else {
      console.warn("Could not generate segment for item:", { item, activeTab, title });
    }
  };

  const defaultRenderItem = (item: CardDataItem, index: number) => {
    const commonClasses = "flex justify-between items-center text-gray-700 py-0.5 px-1";
    const clickableClasses = onItemClick ? "hover:bg-gray-100 cursor-pointer rounded" : "";
    // Generate segment for tooltip preview if possible
    const segment = onItemClick ? generateSegmentForItem(item, activeTab) : null;
    const itemTitle = segment ? `Filter: ${segment.label}` : item.name;

    return (
      <li
        key={`${item.name}-${index}`}
        className={`${commonClasses} ${clickableClasses}`}
        onClick={onItemClick ? () => handleItemClickInternal(item) : undefined}
        title={itemTitle}
      >
        <span className="truncate pr-2" title={item.name}>{item.name}</span>
        <div className="flex items-center space-x-2 flex-shrink-0">
          {item.percentage !== undefined && (
            <span className="text-xs text-gray-500 w-10 text-right">{item.percentage.toFixed(0)}%</span>
          )}
          <span className="font-medium text-gray-900 w-12 text-right">{formatNumber(item.value)}</span>
        </div>
      </li>
    );
  };


  return (
    <div className="p-4 bg-white rounded shadow flex flex-col h-full">
      <div className="flex justify-between items-start mb-3 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
      </div>
      <div className="border-b border-gray-200 mb-3">
        <nav className="-mb-px flex space-x-4 overflow-x-auto" aria-label="Tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm focus:outline-none ${activeTab === tab.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
              aria-current={activeTab === tab.key ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-grow overflow-y-auto max-h-96">
        {/* Use passed loading/error props for card-specific feedback */}
        {loading && <div className="text-sm text-gray-500 py-4 text-center">Loading...</div>}
        {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded text-center">Error: {error}</div>}
        {!loading && !error && currentData.length === 0 && <div
          className="text-sm text-gray-500 py-4 text-center">{noDataMessage || `No data available for ${tabs.find(t => t.key === activeTab)?.label || 'this view'}.`}</div>}
        {!loading && !error && currentData.length > 0 && (
          <>
            {renderHeader && renderHeader(activeTab)}
            <ul className="space-y-1 text-sm">
              {currentData.map((item, index) =>
                renderItem ? renderItem(item, index, activeTab) : defaultRenderItem(item, index)
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};


// ===================== Generic Card machinery =====================
type CardMeta = {
  id: string;
  title: string;
  tabs: { key: string; label: string }[];
  dataSelector: (agg: AggregatedData | null) => Record<string, CardDataItem[]>;
  tabGet: (s: AnalyticsState) => string;
  tabSet: (s: AnalyticsState) => (key: string) => void;
  renderHeader?: (active: string) => React.ReactNode;
  renderItem?: (item: CardDataItem, idx: number, active: string) => React.ReactNode;
  // Updated: getSegment now returns the full Segment object or null
  getSegment: (item: CardDataItem, activeTab: string) => Segment | null;
};

const CARD_META: CardMeta[] = [
  {
    id: 'sources',
    title: 'Sources',
    tabs: [
      { key: 'channels', label: 'Channels' },
      { key: 'sources', label: 'Sources' },
      { key: 'campaigns', label: 'Campaigns' },
    ],
    dataSelector: agg => agg?.sources ?? { channels: [], sources: [], campaigns: [] },
    tabGet: s => s.sourcesTab,
    tabSet: s => s.setSourcesTab,
    renderHeader: () => (
      <div className="flex justify-between items-center text-xs text-gray-500 font-medium mb-1 px-1">
        <span>Name</span>
        <span>Visitors</span>
      </div>
    ),
    getSegment: (item, activeTab) => {
      const tabLabel = CARD_META[0].tabs.find(t => t.key === activeTab)?.label || activeTab;
      let segmentType: string | null = null;
      switch (activeTab) {
        case 'channels': segmentType = 'channel'; break;
        case 'sources': segmentType = 'referer_domain'; break;
        case 'campaigns': segmentType = 'utm_campaign'; break;
      }
      return segmentType ? { type: segmentType, value: item.name, label: `${tabLabel} is ${item.name}` } : null;
    },
  },
  {
    id: 'pages',
    title: 'Pages',
    tabs: [
      { key: 'topPages', label: 'Top Pages' },
      { key: 'entryPages', label: 'Entry Pages' },
      { key: 'exitPages', label: 'Exit Pages' },
    ],
    dataSelector: agg => agg?.pages ?? { topPages: [], entryPages: [], exitPages: [] },
    tabGet: s => s.pagesTab,
    tabSet: s => s.setPagesTab,
    renderHeader: active => (
      <div className="flex justify-between items-center text-xs text-gray-500 font-medium mb-1 px-1">
        <span>{active === 'topPages' ? 'Pathname' : 'Page'}</span>
        <span>{active === 'topPages' ? 'Visitors' : active === 'entryPages' ? 'Entrances' : 'Exits'}</span>
      </div>
    ),
    getSegment: (item, activeTab) => {
      const tabLabel = CARD_META[1].tabs.find(t => t.key === activeTab)?.label || activeTab;
      // All page tabs filter by pathname
      return { type: 'pathname', value: item.name, label: `${tabLabel} is ${item.name}` };
    },
  },
  {
    id: 'regions',
    title: 'Regions',
    tabs: [
      { key: 'countries', label: 'Countries' },
      { key: 'regions', label: 'Regions' },
    ],
    dataSelector: agg => agg?.regions ?? { countries: [], regions: [] },
    tabGet: s => s.regionsTab,
    tabSet: s => s.setRegionsTab,
    renderHeader: () => (
      <div className="flex justify-between items-center text-xs text-gray-500 font-medium mb-1 px-1">
        <span>Name</span>
        <span>Visitors</span>
      </div>
    ),
    getSegment: (item, activeTab) => {
      const tabLabel = CARD_META[2].tabs.find(t => t.key === activeTab)?.label || activeTab;
      let segmentType: string | null = null;
      switch (activeTab) {
        case 'countries': segmentType = 'country'; break;
        case 'regions': segmentType = 'region'; break;
      }
      return segmentType ? { type: segmentType, value: item.name, label: `${tabLabel} is ${item.name}` } : null;
    },
  },
  {
    id: 'devices',
    title: 'Devices',
    tabs: [
      { key: 'browsers', label: 'Browser' },
      { key: 'os', label: 'OS' },
      { key: 'screenSizes', label: 'Size' },
    ],
    dataSelector: agg => agg?.devices ?? { browsers: [], os: [], screenSizes: [] },
    tabGet: s => s.devicesTab,
    tabSet: s => s.setDevicesTab,
    renderHeader: () => (
      <div className="flex justify-between items-center text-xs text-gray-500 font-medium mb-1 px-1">
        <span>Name</span>
        <div className="flex items-center space-x-2 flex-shrink-0">
          <span className="w-10 text-right">%</span>
          <span className="w-12 text-right">Visitors</span>
        </div>
      </div>
    ),
    getSegment: (item, activeTab) => {
      const tabLabel = CARD_META[3].tabs.find(t => t.key === activeTab)?.label || activeTab;
      let segmentType: string | null = null;
      switch (activeTab) {
        case 'browsers': segmentType = 'browser'; break;
        case 'os': segmentType = 'os'; break;
        case 'screenSizes': segmentType = 'screen_size'; break;
      }
      return segmentType ? { type: segmentType, value: item.name, label: `${tabLabel} is ${item.name}` } : null;
    },
  },
];

const CardContainer: React.FC<{
    meta: CardMeta;
    loading: boolean;
    aggregatedData: AggregatedData | null;
    onItemClick: (segment: Segment) => void; // Pass handler down
}> = memo(({ meta, loading, aggregatedData, onItemClick }) => {
  const { activeTab, setActiveTab } = useStore(useShallow(state => ({
    activeTab: meta.tabGet(state),
    setActiveTab: meta.tabSet(state),
  })));

  // Use the meta.getSegment function defined in CARD_META
  const generateSegmentForItem = useCallback((item: CardDataItem, currentActiveTab: string) => {
    return meta.getSegment(item, currentActiveTab);
  }, [meta]); // Depends only on meta object

  return (
    <BaseCard
      cardId={meta.id} // Pass cardId
      title={meta.title}
      loading={loading}
      tabs={meta.tabs}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      data={meta.dataSelector(aggregatedData)}
      renderHeader={meta.renderHeader}
      renderItem={meta.renderItem}
      onItemClick={onItemClick} // Pass handler down
      generateSegmentForItem={generateSegmentForItem} // Pass segment generation helper
    />
  );
});

// -----------------------------------------------------------------

// Rename: CustomPropertiesCard -> EventsCard
const EventsCard: React.FC<{
    // Changed: onItemClick now takes a Segment object directly
    onItemClick: (segment: Segment) => void;
}> = ({ onItemClick }) => {
  const {
    eventsData, availableKeys, aggregatedValues, selectedKey, activeTab, status, error,
    setActiveTab, runCustomPropertyAggregation,
  } = useStore(useShallow(state => ({
    eventsData: state.aggregatedData?.eventsData ?? [],
    availableKeys: state.aggregatedData?.customProperties?.availableKeys ?? [],
    aggregatedValues: state.aggregatedData?.customProperties?.aggregatedValues ?? null,
    selectedKey: state.selectedPropertyKey,
    activeTab: state.eventsTab,
    status: state.status,
    error: state.error,
    setActiveTab: state.setEventsTab,
    runCustomPropertyAggregation: state.runCustomPropertyAggregation,
  })));

  const handlePropertyKeyChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    runCustomPropertyAggregation(event.target.value);
  };

  const cardLoading = status === 'aggregating' || status === 'loading_data' || status === 'initializing';
  const cardError = status === 'error' ? error : null;

  const noKeysAvailable = !cardLoading && !cardError && availableKeys.length === 0;
  const keySelected = !!selectedKey;
  const noDataForSelectedKey = keySelected && !cardLoading && !cardError && Array.isArray(aggregatedValues) && aggregatedValues.length === 0;
  const propDataAvailable = keySelected && !cardLoading && !cardError && aggregatedValues && aggregatedValues.length > 0;

  const noEventsData = !cardLoading && !cardError && eventsData.length === 0;
  const eventDataAvailable = !cardLoading && !cardError && eventsData.length > 0;

  // Helper to generate segment based on tab and item
  const generateSegmentForItem = useCallback((item: CardDataItem): Segment | null => {
    if (activeTab === 'events') {
      return { type: 'event', value: item.name, label: `Event is ${item.name}` };
    } else if (activeTab === 'properties' && selectedKey) {
      return { type: `custom:${selectedKey}`, value: item.name, label: `${selectedKey} is ${item.name}` };
    }
    console.warn("EventsCard: Could not generate segment", { item, activeTab, selectedKey });
    return null;
  }, [activeTab, selectedKey]); // Depends on activeTab and selectedKey

  // Internal click handler that uses the generator
  const handleItemClickInternal = (item: CardDataItem) => {
    const segment = generateSegmentForItem(item);
    if (segment) {
      onItemClick(segment);
    }
  };

  const cardTabs = [
    { key: 'events', label: 'Events' },
    { key: 'properties', label: 'Properties' },
  ];

  return (
    <div className="p-4 bg-white rounded shadow flex flex-col h-full">
      <div className="flex justify-between items-start mb-3 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-gray-800">Events</h2>
        {activeTab === 'properties' && availableKeys.length > 0 && (
          <select value={selectedKey || ''} onChange={handlePropertyKeyChange} disabled={cardLoading}
                  className="text-sm border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                  aria-label="Select custom property">
            <option value="" disabled>Select a property...</option>
            {availableKeys.map((key) => ( <option key={key} value={key}>{key}</option> ))}
          </select>
        )}
        {activeTab === 'properties' && noKeysAvailable && !cardLoading && <span className="text-sm text-gray-500">No properties found</span>}
      </div>

      <div className="border-b border-gray-200 mb-3">
        <nav className="-mb-px flex space-x-4" aria-label="Tabs">
          {cardTabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                    className={`whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm focus:outline-none ${activeTab === tab.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                    aria-current={activeTab === tab.key ? 'page' : undefined}>
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-grow overflow-y-auto max-h-96">
        {cardError && <div className="text-sm text-red-600 bg-red-50 p-2 rounded text-center">Error: {cardError}</div>}
        {!cardError && cardLoading && <div className="text-sm text-gray-500 py-4 text-center">Loading...</div>}

        {activeTab === 'events' && !cardLoading && !cardError && (
          <>
            {eventDataAvailable ? (
              <>
                <div className="flex justify-between items-center text-xs text-gray-500 font-medium mb-1 px-1">
                  <span>Event Name</span>
                  <div className="flex items-center space-x-2 flex-shrink-0">
                    <span className="w-12 text-right">Visitors</span>
                    <span className="w-12 text-right">Count</span>
                    <span className="w-10 text-right">% Visitors</span>
                  </div>
                </div>
                <ul className="space-y-1 text-sm">
                  {eventsData.map((item, index) => {
                    const segment = generateSegmentForItem(item); // Generate for tooltip
                    const itemTitle = segment ? `Filter: ${segment.label}` : item.name;
                    return (
                      <li key={`${item.name}-${index}`}
                          className="flex justify-between items-center text-gray-700 py-0.5 px-1 hover:bg-gray-100 cursor-pointer rounded"
                          onClick={() => handleItemClickInternal(item)} // Use internal handler
                          title={itemTitle} // Use generated title
                      >
                        <span className="truncate pr-2" title={item.name}>{item.name}</span>
                        <div className="flex items-center space-x-2 flex-shrink-0">
                          <span className="font-medium text-gray-900 w-12 text-right">{formatNumber(item.value)}</span>
                          <span className="font-medium text-gray-900 w-12 text-right">{formatNumber(item.events ?? 0)}</span>
                          <span className={`text-xs w-10 text-right ${item.percentage !== undefined ? 'text-gray-500' : 'text-gray-400'}`}>
                            {item.percentage !== undefined ? `${item.percentage.toFixed(0)}%` : '-'}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : ( <div className="text-sm text-gray-500 py-4 text-center">No event data available.</div> )}
          </>
        )}

        {activeTab === 'properties' && !cardLoading && !cardError && (
          <>
            {propDataAvailable && aggregatedValues ? (
              <>
                <div className="flex justify-between items-center text-xs text-gray-500 font-medium mb-1 px-1">
                  <span className="truncate pr-2">{selectedKey || 'Value'}</span>
                  <div className="flex items-center space-x-2 flex-shrink-0">
                    <span className="w-12 text-right">Visitors</span>
                    <span className="w-12 text-right">Events</span>
                    <span className="w-10 text-right">% Visitors</span>
                  </div>
                </div>
                <ul className="space-y-1 text-sm">
                  {aggregatedValues.map((item, index) => {
                    const segment = generateSegmentForItem(item); // Generate for tooltip
                    const itemTitle = segment ? `Filter: ${segment.label}` : item.name;
                    return (
                      <li key={`${item.name}-${index}`}
                          className="flex justify-between items-center text-gray-700 py-0.5 px-1 hover:bg-gray-100 cursor-pointer rounded"
                          onClick={() => handleItemClickInternal(item)} // Use internal handler
                          title={itemTitle} // Use generated title
                      >
                        <span className="truncate pr-2" title={item.name}>{item.name}</span>
                        <div className="flex items-center space-x-2 flex-shrink-0">
                          <span className="font-medium text-gray-900 w-12 text-right">{formatNumber(item.value)}</span>
                          <span className="font-medium text-gray-900 w-12 text-right">{formatNumber(item.events ?? 0)}</span>
                          <span className={`text-xs w-10 text-right ${item.percentage !== undefined ? 'text-gray-500' : 'text-gray-400'}`}>
                            {item.percentage !== undefined ? `${item.percentage.toFixed(0)}%` : '-'}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <>
                {noKeysAvailable && <div className="text-sm text-gray-500 py-4 text-center">No custom properties found.</div>}
                {availableKeys.length > 0 && !keySelected && <div className="text-sm text-gray-500 py-4 text-center">Select a property key above.</div>}
                {noDataForSelectedKey && <div className="text-sm text-gray-500 py-4 text-center">No data for '{selectedKey}'.</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};


// Dynamically import the SankeyCard for client-side rendering only
const LazySankeyCard = lazy(() =>
  import('./components/SankeyCard').then(module => ({ default: module.SankeyCard }))
);
// Import the new UsageCard
import { UsageCard } from './components/UsageCard'; // Assuming path is correct

// --- Main Dashboard Component ---

export default function AnalyticsDashboard() {
  // --- Auth State ---
  const { isAuthenticated, isLoading: isAuthLoading, logout, user } = useAuth();
  const { post } = useApiClient(); // Get post method for Stripe API calls

  // --- Analytics Store State ---
  const {
    selectedRange,
    setSelectedRange,
    aggregatedData,
    status, // Use consolidated status
    error,
    isRefreshing, // Destructure isRefreshing
    segments, // Get segments state
    addSegment, // Get segment actions
    removeSegment,
    clearSegments,
    db,
    sites, // Get sites state
    selectedSiteId, // Get selected site ID
    setSelectedSiteId, // Get setter action
    userPreferences, // Get user preferences
    // fetchSites is called internally by fetchAndLoadData on init
  } = useStore(useShallow(
    // Type is inferred from useStore hook
    (state) => ({
      selectedRange: state.selectedRange,
      setSelectedRange: state.setSelectedRange,
      aggregatedData: state.aggregatedData,
      status: state.status,
      error: state.error,
      isRefreshing: state.isRefreshing, // Add isRefreshing state
      segments: state.segments, // Add segments
      addSegment: state.addSegment,
      removeSegment: state.removeSegment,
      clearSegments: state.clearSegments,
      db: state.db, // Need db state to check for init error
      sites: state.sites,
      selectedSiteId: state.selectedSiteId,
      setSelectedSiteId: state.setSelectedSiteId,
      userPreferences: state.userPreferences, // Add userPreferences
      // fetchSites: state.fetchSites, // Not needed directly here
    })
  ));

  useEffect(() => {
    if (isServer) return;
    // fetchAndLoadData now handles DB init and fetching sites if necessary
    useStore.getState().fetchAndLoadData();

    return () => { useStore.getState().cleanup(); }
    // Depend on endpoint to refetch if it changes
  }, []); // Empty dependency array ensures this runs only once on mount

  // Simplified handler: Receives the fully formed Segment object
  const handleItemClick = useCallback((segment: Segment) => {
    console.log("Adding segment via handleItemClick:", segment);
    addSegment(segment); // Directly call addSegment from the store
  }, [addSegment]); // Dependency: addSegment action

  // Find the selected site object to display its domain and get allowance/plan
  const selectedSite = useMemo(() => sites.find(site => site.site_id === selectedSiteId), [sites, selectedSiteId]);

  // --- Analytics Locking Logic ---
  const isPaymentActive = userPreferences?.is_payment_active ?? false;
  const requestAllowance = selectedSite?.request_allowance ?? 0; // Default to 0 if site not found or allowance missing
  const isLocked = requestAllowance <= 0 && !isPaymentActive;

  // Derive UI states from status
  const isLoading = status === 'initializing' || status === 'loading_data' || status === 'aggregating';
  const isError = status === 'error';
  const isIdle = status === 'idle';

  // Derived data for easier access in JSX
  const stats = aggregatedData?.stats;
  const chartData = aggregatedData?.chartData;

  // Determine overall display state, considering the lock
  const displayDataAvailable = !isLocked && isIdle && !!aggregatedData && !!stats && !!chartData && !!selectedSiteId; // Ensure site is selected and not locked
  // Show "No Data" only when idle, no error, not locked, and aggregatedData is null or empty after trying to load
  const noDataFound = !isLocked && isIdle && !error && !aggregatedData && !!selectedSiteId; // Only show if a site IS selected but has no data and not locked

  // Specific check for critical DB init error
  const dbInitError = isError && !db; // Check if error occurred and db is still null

  // Calculate chart title suffix based on date range duration
  const chartTitleSuffix = useMemo(() => {
    if (!selectedRange?.from || !selectedRange?.to) return '';
    const diff = differenceInDays(selectedRange.to, selectedRange.from);
    return diff <= 1 ? 'per Hour' : 'per Day'; // Hourly if range is 1 day or less
  }, [selectedRange]);

  // --- Auth Loading Check ---
  if (isAuthLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        Checking authentication...
      </div>
    );
  }

  // --- Auth Redirect Check ---
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // --- DB Init Error Check ---
  if (dbInitError) {
    return (
      <div className="min-h-screen bg-gray-100 p-4 sm:p-6 lg:p-8 flex items-center justify-center">
        <div className="text-center py-10 text-red-600 bg-red-100 border border-red-400 rounded p-4">
          Critical Error: Could not initialize the analytics database. <br/>
          {error}
        </div>
      </div>
    )
  }

  // --- Stripe Integration Callbacks ---
  const useStripe = import.meta.env.VITE_USE_STRIPE === 'true';

  const handleSetupAutoPay = async () => {
    if (!useStripe) {
      toast.info("Stripe payments are not enabled in this configuration.");
      console.log("Stripe is disabled. Skipping Setup Intent flow.");
      return;
    }
    console.log("Trigger Stripe Setup Intent flow...");
    toast.info("Initiating payment setup..."); // User feedback
    try {
      // TODO: Replace with actual API call to create Setup Intent and redirect/use Stripe Elements
      // const { clientSecret } = await post<{ clientSecret: string }>('/api/stripe/create-setup-intent');
      // Now use clientSecret with Stripe Elements or redirect to a dedicated setup page
      alert("Placeholder: Redirecting to payment setup (using Setup Intent)...");
      // Example redirect (if not using Elements):
      // window.location.href = `/setup-payment?client_secret=${clientSecret}`;
    } catch (error: any) {
      console.error("Failed to initiate Stripe Setup Intent:", error);
      toast.error(`Failed to start payment setup: ${error.message || 'Unknown error'}`);
    }
  };

  const handleManagePayment = async () => {
    if (!useStripe) {
      toast.info("Stripe payments are not enabled in this configuration.");
      console.log("Stripe is disabled. Skipping Customer Portal.");
      return;
    }
    console.log("Trigger Stripe Customer Portal...");
    toast.info("Redirecting to manage payment..."); // User feedback
    try {
      // TODO: Replace with actual API call to create Portal Session and redirect
      // Pass an empty object as the second argument for POST requests without a body
      const { url } = await post<{ url: string }>('/api/stripe/create-portal-session', {});
      if (url) {
        window.location.href = url;
      } else {
        throw new Error("Portal session URL not received.");
      }
    } catch (error: any) {
      console.error("Failed to create Stripe Customer Portal session:", error);
      toast.error(`Failed to open payment management: ${error.message || 'Unknown error'}`);
    }
  };

  return <>
    <div className="min-h-screen bg-gray-100 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header Section */}
        <header className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          {/* Left Side: Site Selector and Segments */}
          <div className="flex flex-col items-start gap-2">
              {/* Site Selector */}
              <Select
                  value={selectedSiteId ?? ''}
                  onValueChange={(value) => setSelectedSiteId(value || null)}
                  disabled={sites.length === 0 || isLoading || isRefreshing} // Disable while loading/refreshing
              >
                  <SelectTrigger className="w-auto min-w-[180px] h-9 text-lg font-semibold border-none shadow-none focus:ring-0 p-0 gap-2">
                      <div className="flex items-center gap-2">
                           {/* Avatar */}
                           <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold ${selectedSite ? 'bg-blue-500' : 'bg-gray-400'}`}>
                              {selectedSite?.name?.charAt(0).toUpperCase() || '?'}
                           </div>
                           {/* Site Name */}
                           <SelectValue placeholder="Select a site..." />
                      </div>
                  </SelectTrigger>
                  <SelectContent>
                      {sites.length > 0 ? (
                          sites.map((site) => (
                              <SelectItem key={site.site_id} value={site.site_id}>
                                  {site.name} ({site.site_id}) {/* Display name and ID */}
                              </SelectItem>
                          ))
                      ) : (
                          <SelectItem value="loading" disabled>
                            {status === 'error' ? 'Error loading sites' : 'Loading sites...'}
                          </SelectItem>
                      )}
                  </SelectContent>
              </Select>
              {/* Segment Display Area */}
              {segments.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                      {segments.map((segment, index) => (
                          <span key={index} className="flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-medium px-2 py-0.5 rounded-full">
                              {segment.label}
                              <button
                                  onClick={() => removeSegment(segment)}
                                  className="ml-1 text-blue-600 hover:text-blue-800 focus:outline-none"
                                  aria-label={`Remove filter: ${segment.label}`}
                                  title={`Remove filter: ${segment.label}`}
                              >
                                  &times; {/* Cross icon */}
                              </button>
                          </span>
                      ))}
                      {/* Optional: Add a "Clear All" button */}
                      {segments.length > 1 && (
                          <button
                              onClick={clearSegments}
                              className="text-xs text-gray-500 hover:text-gray-700 underline focus:outline-none ml-1"
                              title="Clear all filters"
                          >
                              Clear all
                          </button>
                      )}
                  </div>
              )}
          </div>

          {/* Right Side: Date Range Picker & Logout */}
          <div className="flex items-center gap-4 text-sm text-gray-600 flex-shrink-0">
              {/* Refresh Indicator */}
              {isRefreshing && <span className="text-xs text-gray-400 animate-pulse">(syncing...)</span>}
              {/* User Info & Logout */}
              {user && (
                <span className="text-xs text-gray-500 hidden sm:inline">
                  Logged in as: {user.username}
                </span>
              )}
              <Button onClick={logout} variant="outline" size="sm">Logout</Button>
              {/* Date Range Picker */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    id="date"
                    variant={"outline"}
                    className={cn(
                      "w-[260px] justify-start text-left font-normal",
                      !selectedRange && "text-muted-foreground"
                    )}
                    disabled={isLoading || !selectedSiteId} // Disable if loading or no site selected
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedRange?.from ? (
                      selectedRange.to ? (
                        <>
                          {format(selectedRange.from, "LLL dd, y")} -{" "}
                          {format(selectedRange.to, "LLL dd, y")}
                        </>
                      ) : (
                        format(selectedRange.from, "LLL dd, y")
                      )
                    ) : (
                      <span>Pick a date</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    initialFocus
                    mode="range"
                    defaultMonth={selectedRange?.from}
                    selected={selectedRange}
                    onSelect={setSelectedRange} // Use store action directly
                    numberOfMonths={2}
                    disabled={(date) => date > new Date() || date < new Date("2000-01-01")} // Example disabled dates
                  />
                </PopoverContent>
              </Popover>
          </div>
        </header>

        {/* Loading State */}
        {isLoading && (
          <div className="text-center py-10 text-gray-500">Loading analytics data ({status})...</div>
        )}

        {/* Error State (excluding DB init error handled above) */}
        {isError && !dbInitError && (
          <div className="text-center py-10 text-red-600 bg-red-100 border border-red-400 rounded p-4 mb-6">
            Error loading data: {error}
          </div>
        )}

       {/* No Data State - Updated message */}
       {isIdle && !error && !selectedSiteId && sites.length > 0 && (
            <div className="text-center py-10 text-gray-500">Please select a site to view analytics.</div>
       )}
       {noDataFound && ( // This covers the case where a site is selected but has no data
         <div className="text-center py-10 text-gray-500">No analytics data found for '{selectedSite?.name}' in the selected period {segments.length > 0 ? 'matching the current filters' : ''}.</div>
       )}

       {/* Display Locked State */}
       {isLocked && selectedSiteId && (
         <div className="text-center py-10 text-red-700 bg-red-100 border border-red-300 rounded p-6 mb-6">
           <h2 className="text-xl font-semibold mb-2">Analytics Paused</h2>
           <p className="mb-4">Your request allowance for '{selectedSite?.name}' is depleted.</p>
           <p className="mb-4">Please set up auto-pay to reactivate analytics and ensure uninterrupted service.</p>
           <Button onClick={handleSetupAutoPay}>Setup Auto-Pay Now</Button>
         </div>
       )}

       {/* Display content when data is available, status is idle, and not locked */}
        {displayDataAvailable && stats && chartData && ( // Added null checks for stats/chartData
          <>
            {/* Stats Overview Section */}
            <section className="mb-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <div className={`p-4 bg-white rounded shadow`}>
                <h3 className="text-sm font-medium text-gray-500">Unique Visits</h3>
                <p className="text-2xl font-bold text-gray-800">{formatNumber(stats.uniqueVisitors)}</p>
              </div>
              <div className="p-4 bg-white rounded shadow">
                <h3 className="text-sm font-medium text-gray-500">Total Visits</h3>
                <p className="text-2xl font-bold text-gray-800">{formatNumber(stats.totalVisits)}</p>
              </div>
              <div className="p-4 bg-white rounded shadow">
                <h3 className="text-sm font-medium text-gray-500">Total Pageviews</h3>
                <p className="text-2xl font-bold text-gray-800">{formatNumber(stats.totalPageviews)}</p>
              </div>
              <div className="p-4 bg-white rounded shadow">
                <h3 className="text-sm font-medium text-gray-500">Views per Visit</h3>
                <p className="text-2xl font-bold text-gray-800">{stats.viewsPerVisit}</p>
              </div>
              <div className="p-4 bg-white rounded shadow">
                <h3 className="text-sm font-medium text-gray-500">Bounce Rate</h3>
                {/* Display the calculated bounce rate from stats */}
                <p className="text-2xl font-bold text-gray-800">{stats.bounceRate}</p>
              </div>
              <div className="p-4 bg-white rounded shadow">
                <h3 className="text-sm font-medium text-gray-500">Visit Duration</h3>
                {/* Display the calculated visit duration from stats */}
                <p className="text-2xl font-bold text-gray-800">{stats.visitDuration}</p>
              </div>
            </section>

            {/* Main Chart Section */}
            <section className="mb-6 p-4 bg-white rounded shadow">
              <h2 className="text-lg font-semibold text-gray-800 mb-4">
                Visitor Trends (Pageviews {chartTitleSuffix}) {/* Use calculated suffix */}
              </h2>
              <div className="h-64">
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={chartData}
                      margin={{top: 5, right: 30, left: 20, bottom: 5}}
                    >
                      <CartesianGrid strokeDasharray="3 3"/>
                      <XAxis dataKey="date"/>
                      <YAxis/>
                      <Tooltip/>
                      <Line type="monotone" dataKey="views" name="Pageviews" stroke="#8884d8" activeDot={{r: 8}}
                            dot={false}/>
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-gray-500">
                    No chart data available for the selected period {segments.length > 0 ? 'matching the current filters' : ''}.
                  </div>
                )}
              </div>
            </section>

            {/* Detailed Breakdown Sections - Grid for most cards */}
            <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6"> {/* Added mb-6 */}
              {/* Pass loading state and click handler to cards */}
              {CARD_META.map(meta => (
                 <CardContainer
                   key={meta.id}
                   meta={meta}
                   loading={isLoading}
                   aggregatedData={aggregatedData}
                   onItemClick={handleItemClick} // Pass handler
                 />
              ))}
              {/* Rename and pass handler to the new EventsCard */}
              <EventsCard onItemClick={handleItemClick} />
              {/* Add the new Usage Card with updated props */}
              {selectedSite && userPreferences && ( // Only render if site and prefs are loaded
                 <UsageCard
                   request_allowance={selectedSite.request_allowance}
                   plan={selectedSite.plan}
                   is_payment_active={userPreferences.is_payment_active}
                   stripe_last4={userPreferences.stripe_last4}
                   onSetupAutoPay={handleSetupAutoPay} // Pass callback
                   onManagePayment={handleManagePayment} // Pass callback
                 />
              )}
              {/* Sankey Card is moved below this grid */}
            </section>

            {/* User Flow Section - Full Width */}
            <section className="w-full"> {/* Ensure full width */}
               {/* Wrap the lazy-loaded component with Suspense */}
               <Suspense fallback={<div className="p-4 bg-white rounded shadow h-96 flex items-center justify-center text-gray-400">Loading Flow Chart...</div>}>
                 {!isServer && <LazySankeyCard />} {/* Render only on client */}
               </Suspense>
            </section>
          </>
        )}

      </div>
    </div>
  </>;
};
