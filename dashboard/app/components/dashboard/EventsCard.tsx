import React, { useCallback } from 'react';
import { useShallow } from 'zustand/shallow';
import { useSqlStore } from '../../stores/analyticsSqlStore'; // Import SQL store
import { useHttpStore } from '../../stores/analyticsHttpStore'; // Import HTTP store
import type { CardDataItem, Segment } from '../../stores/analyticsTypes'; // Keep type imports

// Helper function (defined locally as per instructions)
const formatNumber = (num: number) => num.toLocaleString();

// Rename: CustomPropertiesCard -> EventsCard
export const EventsCard: React.FC<{
    // Changed: onItemClick now takes a Segment object directly
    onItemClick: (segment: Segment) => void;
}> = ({ onItemClick }) => {
  // Select state from SQL store
  const {
    eventsData, availableKeys, aggregatedValues, selectedKey, status, error,
    runCustomPropertyAggregation,
  } = useSqlStore(useShallow(state => ({
    eventsData: state.aggregatedData?.eventsData ?? [],
    availableKeys: state.aggregatedData?.customProperties?.availableKeys ?? [],
    aggregatedValues: state.aggregatedData?.customProperties?.aggregatedValues ?? null,
    selectedKey: state.selectedPropertyKey,
    status: state.status,
    error: state.error,
    runCustomPropertyAggregation: state.runCustomPropertyAggregation,
  })));

  // Select state from HTTP store
  const { activeTab, setActiveTab } = useHttpStore(useShallow(state => ({
    activeTab: state.eventsTab,
    setActiveTab: state.setEventsTab,
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
            {availableKeys.map((key: string) => ( <option key={key} value={key}>{key}</option> ))}
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
                  {eventsData.map((item: CardDataItem, index: number) => { // Added types
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
                  {aggregatedValues.map((item: CardDataItem, index: number) => { // Added types
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