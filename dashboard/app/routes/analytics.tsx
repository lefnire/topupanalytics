import React, {useState, useEffect, useMemo, useCallback, lazy, Suspense, memo} from 'react'; // Add lazy and Suspense
import {useShallow} from 'zustand/shallow'; // Correct import
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {useStore, type AnalyticsState, type AggregatedData, type CardDataItem, type Segment} from '../stores/analyticsStore'; // Import Segment
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
  // Get state and actions from store using consolidated status/error
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
    db
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
    })
  ));

  useEffect(() => {
    if (isServer) return;
    useStore.getState().fetchAndLoadData();

    return () => { useStore.getState().cleanup(); }
    // Depend on endpoint to refetch if it changes
  }, []);

  const handleRangeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedRange(event.target.value); // This already clears segments in the store action
  };

  // Simplified handler: Receives the fully formed Segment object
  const handleItemClick = useCallback((segment: Segment) => {
    console.log("Adding segment via handleItemClick:", segment);
    addSegment(segment); // Directly call addSegment from the store
  }, [addSegment]); // Dependency: addSegment action

  const domainName = 'ocdevel.com'; // Changed from 'Your Site'

  const dateRanges = [
    {value: '1d', label: 'Last 24 hours'},
    {value: '7d', label: 'Last 7 days'},
    {value: '30d', label: 'Last 30 days'},
    {value: '90d', label: 'Last 90 days'},
  ];

  // Derive UI states from status
  const isLoading = status === 'initializing' || status === 'loading_data' || status === 'aggregating';
  const isError = status === 'error';
  const isIdle = status === 'idle';

  // Derived data for easier access in JSX
  const stats = aggregatedData?.stats;
  const chartData = aggregatedData?.chartData;

  // Determine overall display state
  const displayDataAvailable = isIdle && !!aggregatedData && !!stats && !!chartData;
  // Show "No Data" only when idle, no error, and aggregatedData is null or empty after trying to load
  const noDataFound = isIdle && !error && !aggregatedData;

  // Specific check for critical DB init error
  const dbInitError = isError && !db; // Check if error occurred and db is still null

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

  return <>
    <div className="min-h-screen bg-gray-100 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header Section */}
        <header className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            {/* Left Side: Site Name and Segments */}
            <div className="flex flex-col items-start gap-2">
                <div className="flex items-center gap-3">
                    {/* Replace img with a styled div for the avatar */}
                    <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-bold">
                      {domainName?.charAt(0).toUpperCase() || 'A'}
                    </div>
                    {/*<img src="/assets/ocdevel-red.svg" alt="ocdevel logo" className="w-6 h-6" />*/}
                    <h1 className="text-xl font-semibold text-gray-800">{domainName}</h1>
                     <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-gray-400">
                       <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                     </svg>
                </div>
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

            {/* Right Side: Date Range Selector */}
            <div className="flex items-center gap-4 text-sm text-gray-600 flex-shrink-0">
                {/* Add background refresh indicator */}
                {isRefreshing && <span className="text-xs text-gray-400 animate-pulse">(syncing...)</span>}
                <select
                    value={selectedRange}
                    onChange={handleRangeChange}
                    disabled={isLoading} // Disable during any loading state
                    className="px-3 py-1 border rounded bg-white hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                    aria-label="Select date range"
                >
                    {dateRanges.map(range => (
                        <option key={range.value} value={range.value}>{range.label}</option>
                    ))}
                </select>
                 {/* Ellipsis Button Placeholder - REMOVED */}
                 {/* <button className="p-1 text-gray-400 hover:text-gray-600 focus:outline-none">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                     <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
                   </svg>
                 </button> */}
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

        {/* No Data State */}
        {noDataFound && (
          <div className="text-center py-10 text-gray-500">No analytics data found for the selected period {segments.length > 0 ? 'matching the current filters' : ''}.</div>
        )}

        {/* Display content when data is available and status is idle */}
        {displayDataAvailable && (
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
                Visitor Trends (Pageviews {selectedRange === '1d' ? 'per Hour' : 'per Day'})
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
              {/* Add the new Usage Card */}
              <UsageCard
                currentUsage={stats?.totalPageviews ?? 0} // Use pageviews as placeholder
                usageLimit={500000} // Hardcoded limit
                hasCreditCard={false} // Placeholder for payment status
              />
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
