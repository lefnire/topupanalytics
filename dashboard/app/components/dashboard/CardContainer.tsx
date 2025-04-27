import React, { memo, useCallback } from 'react';
import { useStore } from '../../stores/analyticsStore'; // Adjusted path
import { useShallow } from 'zustand/shallow'; // Import useShallow from zustand
import type { AnalyticsState, AggregatedData, CardDataItem, Segment } from '../../stores/analyticsStore'; // Adjusted path
import { BaseCard } from '../BaseCard'; // Adjusted path

// ===================== Generic Card machinery =====================
export type CardMeta = { // Added export
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

export const CARD_META: CardMeta[] = [ // Added export
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
      // Need to reference CARD_META[0] here, which is now local
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
      // Need to reference CARD_META[1] here, which is now local
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
      // Need to reference CARD_META[2] here, which is now local
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
      // Need to reference CARD_META[3] here, which is now local
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

export const CardContainer: React.FC<{ // Added export
    meta: CardMeta;
    loading: boolean;
    aggregatedData: AggregatedData | null;
    onItemClick: (segment: Segment) => void; // Pass handler down
}> = memo(({ meta, loading, aggregatedData, onItemClick }) => {
  const { activeTab, setActiveTab } = useStore(useShallow((state: AnalyticsState) => ({ // Add AnalyticsState type
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