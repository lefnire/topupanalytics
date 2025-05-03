import React from 'react';
import { ResponsiveSankey } from '@nivo/sankey';
import type { SankeyNodeDatum, SankeyLinkDatum } from '@nivo/sankey';
// Import from the new SQL store
import { useSqlStore } from '../../stores/analyticsSqlStore';
// Import types that were previously exported from analyticsStore (now likely in analyticsTypes or SQL store)
import type { SankeyNode, SankeyLink, AnalyticsStatus } from '../../stores/analyticsTypes'; // Assuming types are in analyticsTypes
import { useShallow } from 'zustand/shallow';

// Helper to map store status + data availability to display state
const getDisplayState = (status: AnalyticsStatus, hasData: boolean): 'loading' | 'error' | 'nodata' | 'ready' => {
    if (status === 'aggregating' || status === 'loading_data' || status === 'initializing') return 'loading';
    if (status === 'error') return 'error';
    if (status === 'idle' && !hasData) return 'nodata';
    if (status === 'idle' && hasData) return 'ready';
    // Default/fallback cases
    if (!hasData) return 'nodata'; // Handle case where status might be unexpected but no data exists
    return 'ready';
};

// Define the expected data structure for the component props if needed,
// but Nivo's types often suffice. We get data directly from the store here.

export const SankeyCard: React.FC = () => {
    // Select state from the SQL store
    const { sankeyData, status, error } = useSqlStore(useShallow(state => ({
        sankeyData: state.sankeyData,
        status: state.status,
        error: state.error,
    })));

    const hasData = !!sankeyData && sankeyData.nodes.length > 0 && sankeyData.links.length > 0;
    const displayState = getDisplayState(status, hasData);

    return (
        <div className="p-4 bg-white rounded shadow flex flex-col h-96"> {/* Fixed height */}
            <div className="flex justify-between items-start mb-3">
                <h2 className="text-lg font-semibold text-gray-800">User Flow</h2>
                {/* Add controls later if needed */}
            </div>
            <div className="flex-grow relative"> {/* Ensure chart fills space */}
                {displayState === 'loading' && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500"> Loading Flow Data... </div>
                )}
                {displayState === 'error' && (
                     <div className="absolute inset-0 flex items-center justify-center text-sm text-red-600 bg-red-50 p-2 rounded"> Error loading flow data: {error || 'Unknown Error'} </div>
                )}
                {displayState === 'nodata' && (
                     <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500"> No user flow data available for the selected period/filters. </div>
                )}
                {displayState === 'ready' && sankeyData && ( // Ensure sankeyData is checked here too
                    <ResponsiveSankey
                        data={sankeyData}
                        margin={{ top: 5, right: 5, bottom: 5, left: 5 }}
                        align="justify"
                        colors={{ scheme: 'category10' }}
                        nodeOpacity={1}
                        nodeHoverOthersOpacity={0.35}
                        nodeThickness={18}
                        nodeSpacing={24}
                        nodeBorderWidth={0}
                        nodeBorderColor={{ from: 'color', modifiers: [['darker', 0.8]] }}
                        nodeTooltip={({ node }: { node: SankeyNodeDatum<SankeyNode, SankeyLink> }) => (
                            <div className="bg-gray-800 text-white p-2 rounded shadow text-xs">
                                {/* Use cleaned label from store, fallback to id */}
                                <strong>{node.label ?? node.id}</strong>
                            </div>
                        )}
                        linkOpacity={0.5}
                        linkHoverOthersOpacity={0.1}
                        linkContract={3}
                        linkTooltip={({ link }: { link: SankeyLinkDatum<SankeyNode, SankeyLink> }) => (
                             <div className="bg-gray-800 text-white p-2 rounded shadow text-xs">
                                {link.source.label ?? link.source.id} → {link.target.label ?? link.target.id}
                                <br />
                                <strong>{link.value} sessions</strong>
                            </div>
                        )}
                        enableLinkGradient={false}
                        labelPosition="inside"
                        labelOrientation="horizontal"
                        labelPadding={3} // Slightly adjusted padding
                        labelTextColor={{ from: 'color', modifiers: [['darker', 1]] }}
                        // Legends commented out for brevity
                    />
                )}
            </div>
        </div>
    );
};