import React, { useEffect } from 'react';
import type { CardDataItem, Segment } from '~/stores/analyticsStore'; // Adjusted path

// --- Helper Functions ---
// Copied from dashboard.tsx as it's simple
const formatNumber = (num: number) => num.toLocaleString();

// --- Component Definition ---
export interface CardProps { // Added export
  title: string;
  tabs: { key: string; label: string }[];
  data: Record<string, CardDataItem[]>;
  renderHeader?: (activeTab: string) => React.ReactNode;
  renderItem?: (item: CardDataItem, index: number, activeTab: string) => React.ReactNode;
  activeTab: string;
  setActiveTab: (key: string) => void;
  onItemClick?: (segment: Segment) => void;
  generateSegmentForItem: (item: CardDataItem, activeTab: string) => Segment | null;
  cardId: string;
  loading?: boolean;
  error?: string | null;
  noDataMessage?: string;
}

export const BaseCard: React.FC<CardProps> = ({ // Added export
  title,
  tabs,
  data,
  renderHeader,
  renderItem,
  activeTab,
  setActiveTab,
  onItemClick,
  generateSegmentForItem,
  cardId,
  loading,
  error,
  noDataMessage
}) => {
  const currentData = data[activeTab] || [];

  useEffect(() => {
    const validTabs = tabs.map(t => t.key);
    if (!validTabs.includes(activeTab) && validTabs.length > 0) {
      setActiveTab(validTabs[0]);
    }
  }, [tabs, activeTab, setActiveTab]);

  const handleItemClickInternal = (item: CardDataItem) => {
    if (!onItemClick) return;
    const segment = generateSegmentForItem(item, activeTab);
    if (segment) {
      onItemClick(segment);
    } else {
      console.warn("Could not generate segment for item:", { item, activeTab, title });
    }
  };

  const defaultRenderItem = (item: CardDataItem, index: number) => {
    const commonClasses = "flex justify-between items-center text-gray-700 py-0.5 px-1";
    const clickableClasses = onItemClick ? "hover:bg-gray-100 cursor-pointer rounded" : "";
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