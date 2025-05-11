import React, { useMemo } from 'react';
import { useHttpStore, type AnalyticsHttpState } from '../../stores/analyticsHttpStore'; // Import HttpStore and its type
import { useShallow } from 'zustand/shallow'; // Import useShallow
import type { Site } from '../../lib/api'; // Import Site type

const useStripe = import.meta.env.VITE_USE_STRIPE === 'true';

// Helper function (can be moved to a utils file later if needed)
const formatNumber = (num: number | undefined | null): string => {
  // Handle undefined, null, or NaN gracefully
  if (typeof num !== 'number' || isNaN(num)) {
    return '0';
  }
  return num.toLocaleString();
};

interface UsageCardProps {
  // Props to remove: requests_used, initial_allowance, request_allowance, plan, is_payment_active, stripe_last4
  onSetupAutoPay: () => void; // Callback to trigger Stripe Setup Intent flow
  onManagePayment: () => void; // Callback to link to Stripe Customer Portal (implement later)
}

export const UsageCard: React.FC<UsageCardProps> = ({
  onSetupAutoPay,
  onManagePayment,
}) => {
  // Subscribe to HttpStore
  const { sites, selectedSiteId, userPreferences } = useHttpStore(
    useShallow((state: AnalyticsHttpState) => ({
      sites: state.sites,
      selectedSiteId: state.selectedSiteId,
      userPreferences: state.userPreferences,
    }))
  );

  // Internalize derivation of selectedSite and related values
  const selectedSite = useMemo(() => sites.find((site: Site) => site.site_id === selectedSiteId), [sites, selectedSiteId]);

  const requests_used = useMemo(() => {
    if (!selectedSite) return 0;
    // TODO: Make initial allowance dynamic based on plan
    const initial_allowance = selectedSite.plan === 'free_tier' ? 10000 : 0; // Hardcoded for now
    return Math.max(0, initial_allowance - (selectedSite.request_allowance ?? 0));
  }, [selectedSite]);

  const initial_allowance = useMemo(() => {
    if (!selectedSite) return 0;
    // TODO: Make initial allowance dynamic based on plan
    return selectedSite.plan === 'free_tier' ? 10000 : 0; // Hardcoded for now
  }, [selectedSite]);

  const request_allowance = useMemo(() => selectedSite?.request_allowance ?? 0, [selectedSite]);
  const plan = useMemo(() => selectedSite?.plan ?? '', [selectedSite]);
  const is_payment_active = useMemo(() => userPreferences?.is_payment_active ?? false, [userPreferences]);
  const stripe_last4 = useMemo(() => userPreferences?.stripe_last4, [userPreferences]);


  // Depletion logic still uses the remaining request_allowance
  const allowanceDepleted = request_allowance <= 0;
  const showSetupPrompt = !is_payment_active;
  const showDepletedWarning = allowanceDepleted && !is_payment_active;

  return (
    <div className="p-4 bg-white rounded shadow flex flex-col h-full">
      <h2 className="text-lg font-semibold text-gray-800 mb-3">Usage Allowance</h2>

      <div className="mb-4">
        <div className="flex justify-between items-baseline mb-1 text-sm">
          {/* Updated Label */}
          <span className="font-medium text-gray-700">Requests Used</span>
          {/* Updated Value: Used / Initial */}
          <span className={`font-semibold ${allowanceDepleted ? 'text-red-600' : 'text-gray-900'}`}>
            {formatNumber(requests_used)} / {formatNumber(initial_allowance)}
          </span>
        </div>
        {/* Progress bar removed as it's less relevant for a depleting balance model */}
      </div>

      {useStripe ? (
        <>
          <div className="text-sm text-gray-600 mb-4 flex-grow">
            <p>Includes 1k free requests.</p>
            <p>Auto-pay enabled ($5 per 500k requests) when payment method is active.</p>
            <div className="mt-2 space-x-2">
              {is_payment_active ? (
                stripe_last4 ? (
                  <span className="text-xs text-green-700 font-medium">
                    Auto-Pay Active (Card ending in {stripe_last4})
                    <button onClick={onManagePayment} className="ml-2 text-xs text-blue-600 hover:underline focus:outline-none">(Manage)</button>
                  </span>
                ) : (
                  // Fallback if last4 isn't available for some reason
                  <span className="text-xs text-green-700 font-medium">
                    Auto-Pay Active
                    <button onClick={onManagePayment} className="ml-2 text-xs text-blue-600 hover:underline focus:outline-none">(Manage)</button>
                  </span>
                )
              ) : (
                <button onClick={onSetupAutoPay} className="text-xs text-blue-600 hover:underline focus:outline-none">
                  Setup Auto-Pay
                </button>
              )}
              {/* "Top-up Manually" button removed */}
            </div>
          </div>

          {(showSetupPrompt || showDepletedWarning) && (
            <div className="mt-auto border-t border-gray-200 pt-3">
              <div className={`p-3 rounded text-center text-sm ${showDepletedWarning ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
                {showDepletedWarning ? (
                  <>
                    <p className="font-medium mb-1">Allowance Depleted</p>
                    <p className="text-xs">Setup Auto-Pay to continue service and ensure uninterrupted analytics.</p>
                  </>
                ) : (
                  <p className="font-medium mb-1">Enable Auto-Pay</p>
                )}
                {!is_payment_active && (
                  <button onClick={onSetupAutoPay} className="mt-2 text-xs text-blue-600 hover:underline focus:outline-none">
                    Setup Auto-Pay Now
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-gray-600 mb-4 flex-grow">
          <p>Includes 1k free requests.</p>
          <p className="mt-2 text-xs text-gray-500 italic">Billing is managed externally or disabled for this instance.</p>
        </div>
      )}
    </div>
  );
};