import React, { Suspense, lazy, useMemo, useCallback } from 'react'; // Added useMemo, useCallback
import { differenceInDays } from 'date-fns'; // Added date-fns
import { Button } from '../ui/button';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { CardContainer, CARD_META } from './CardContainer';
import { EventsCard } from './EventsCard';
import { UsageCard } from './UsageCard';
import { useApiClient } from '../../lib/api';
import { toast } from 'sonner';
import { useStore, type AnalyticsState } from '../../stores/analyticsStore'; // Import hook and state
import type { Segment, AggregatedData } from '../../stores/analyticsTypes'; // Import types separately
import { useShallow } from 'zustand/shallow'; // Import useShallow from zustand
import { type Site } from '../../lib/api'; // Import Site type

// --- Helper Functions ---
const formatNumber = (num: number) => num.toLocaleString();
const isServer = typeof window === 'undefined';

// Dynamically import the SankeyCard for client-side rendering only
const LazySankeyCard = lazy(() =>
  import('./SankeyCard').then(module => ({ default: module.SankeyCard }))
);


// --- Component Definition ---
const DashboardContent = () => {

  // Fetch state and actions directly from the store
  const {
    status,
    error,
    db,
    selectedSiteId,
    sites,
    segments,
    aggregatedData,
    userPreferences,
    selectedRange,
    addSegment,
  } = useStore(useShallow((state: AnalyticsState) => ({ // Add AnalyticsState type
    status: state.status,
    error: state.error,
    db: state.db,
    selectedSiteId: state.selectedSiteId,
    sites: state.sites,
    segments: state.segments,
    aggregatedData: state.aggregatedData,
    userPreferences: state.userPreferences,
    selectedRange: state.selectedRange,
    addSegment: state.addSegment,
  })));

  // Derive states locally
  const useStripe = import.meta.env.VITE_USE_STRIPE === 'true';
  const isLoading = status === 'initializing' || status === 'loading_data' || status === 'aggregating';
  const isError = status === 'error';
  const isIdle = status === 'idle';
  const dbInitError = isError && !db; // Moved dbInitError check here
  const selectedSite = useMemo(() => sites.find((site: Site) => site.site_id === selectedSiteId), [sites, selectedSiteId]); // Add Site type
  const isPaymentActive = userPreferences?.is_payment_active ?? false;
  const requestAllowance = selectedSite?.request_allowance ?? 0; // Remaining allowance
  // TODO: Make initial allowance dynamic based on plan
  const initialAllowance = selectedSite?.plan === 'free_tier' ? 10000 : 0; // Hardcoded for now
  const requestsUsed = Math.max(0, initialAllowance - requestAllowance); // Calculate used, ensure non-negative

  const isLocked = useStripe && requestAllowance <= 0 && !isPaymentActive;
  const stats = aggregatedData?.stats;
  const chartData = aggregatedData?.chartData;
  const displayDataAvailable = !isLocked && isIdle && !!aggregatedData && !!stats && !!chartData && !!selectedSiteId;
  const noDataFound = !isLocked && isIdle && !error && !aggregatedData && !!selectedSiteId;

  // Define handleItemClick locally
  const handleItemClick = useCallback((segment: Segment) => {
      console.log("Adding segment via DashboardContent handleItemClick:", segment);
      addSegment(segment);
  }, [addSegment]);

  // Calculate chart title suffix locally
  const chartTitleSuffix = useMemo(() => {
      if (!selectedRange?.from || !selectedRange?.to) return '';
      const diff = differenceInDays(selectedRange.to, selectedRange.from);
      return diff <= 1 ? 'per Hour' : 'per Day';
  }, [selectedRange]);


  // Stripe Integration Logic (Remains the same)
  const { post } = useApiClient();

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

  // Add the dbInitError check at the beginning of the return statement
  if (dbInitError) {
    return (
      <div className="text-center py-10 text-red-600 bg-red-100 border border-red-400 rounded p-4">
        Critical Error: Could not initialize the analytics database. <br/>
        {error}
      </div>
    );
  }

  // --- JSX Rendering ---
  // Uses locally defined state/variables now
  return (
    <div>
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
     {isIdle && !error && !selectedSiteId && aggregatedData === null && ( // Check aggregatedData directly for no site selected case
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
                 loading={isLoading} // Pass loading state
                 aggregatedData={aggregatedData}
                 onItemClick={handleItemClick} // Pass locally defined handler
               />
            ))}
            {/* Rename and pass handler to the new EventsCard */}
            <EventsCard onItemClick={handleItemClick} /> {/* Pass locally defined handler */}
            {/* Add the new Usage Card with updated props */}
            {selectedSite && userPreferences && ( // Only render if site and prefs are loaded
               <UsageCard
                 requests_used={requestsUsed} // Pass calculated used requests
                 initial_allowance={initialAllowance} // Pass initial allowance
                 request_allowance={selectedSite.request_allowance} // Still pass remaining for warning logic
                 plan={selectedSite.plan}
                 is_payment_active={userPreferences.is_payment_active}
                 stripe_last4={userPreferences.stripe_last4}
                 onSetupAutoPay={handleSetupAutoPay} // Pass callback
                 onManagePayment={handleManagePayment} // Pass callback
               />
            )}
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
  );
};

export { DashboardContent }; // Export the component