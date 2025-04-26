import React from 'react';

// Helper function (can be moved to a utils file later if needed)
const formatNumber = (num: number) => num.toLocaleString();

interface UsageCardProps {
  request_allowance: number;
  plan: string; // Assuming plan is a string like 'free', 'paid', etc. - adjust if needed
  is_payment_active: boolean;
  stripe_last4?: string | null; // Optional, only present if payment is active
  onSetupAutoPay: () => void; // Callback to trigger Stripe Setup Intent flow
  onManagePayment: () => void; // Callback to link to Stripe Customer Portal (implement later)
}

export const UsageCard: React.FC<UsageCardProps> = ({
  request_allowance,
  plan, // plan might be used for future display logic, keeping it for now
  is_payment_active,
  stripe_last4,
  onSetupAutoPay,
  onManagePayment,
}) => {
  const allowanceDepleted = request_allowance <= 0;
  const showSetupPrompt = !is_payment_active;
  const showDepletedWarning = allowanceDepleted && !is_payment_active;

  return (
    <div className="p-4 bg-white rounded shadow flex flex-col h-full">
      <h2 className="text-lg font-semibold text-gray-800 mb-3">Usage Allowance</h2>

      <div className="mb-4">
        <div className="flex justify-between items-baseline mb-1 text-sm">
          <span className="font-medium text-gray-700">Remaining Requests</span>
          <span className={`font-semibold ${allowanceDepleted ? 'text-red-600' : 'text-gray-900'}`}>
            {formatNumber(request_allowance)}
          </span>
        </div>
        {/* Progress bar removed as it's less relevant for a depleting balance model */}
      </div>

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
    </div>
  );
};