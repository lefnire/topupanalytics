import React from 'react';

// Helper function (can be moved to a utils file later if needed)
const formatNumber = (num: number) => num.toLocaleString();

interface UsageCardProps {
  currentUsage: number;
  usageLimit: number;
  hasCreditCard: boolean; // Placeholder for payment status
}

export const UsageCard: React.FC<UsageCardProps> = ({
  currentUsage,
  usageLimit,
  hasCreditCard,
}) => {
  const usagePercentage = Math.min((currentUsage / usageLimit) * 100, 100); // Cap at 100%
  const limitReached = currentUsage >= usageLimit;
  const showAd = !hasCreditCard || limitReached;

  // Determine progress bar color
  let progressBarColor = 'bg-blue-500'; // Default blue
  if (usagePercentage > 80) progressBarColor = 'bg-yellow-500'; // Yellow warning
  if (limitReached) progressBarColor = 'bg-red-500'; // Red limit reached

  return (
    <div className="p-4 bg-white rounded shadow flex flex-col h-full">
      <h2 className="text-lg font-semibold text-gray-800 mb-3">Usage</h2>

      <div className="mb-4">
        <div className="flex justify-between items-baseline mb-1 text-sm">
          <span className="font-medium text-gray-700">Requests</span>
          <span className={`font-semibold ${limitReached ? 'text-red-600' : 'text-gray-900'}`}>
            {formatNumber(currentUsage)} / {formatNumber(usageLimit)}
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
          <div
            className={`${progressBarColor} h-2.5 rounded-full transition-all duration-500 ease-out`}
            style={{ width: `${usagePercentage}%` }}
            title={`${usagePercentage.toFixed(1)}% Used`}
          ></div>
        </div>
        <p className="text-xs text-gray-500 mt-1 text-right">
          {limitReached ? 'Limit reached. Top-up required.' : `${formatNumber(usageLimit - currentUsage)} remaining`}
        </p>
      </div>

      <div className="text-sm text-gray-600 mb-4 flex-grow">
        <p>Your plan includes {formatNumber(usageLimit)} requests per cycle.</p>
        <p>Additional usage is billed at $5 per 500k requests.</p>
        {/* Placeholder links/buttons for future functionality */}
        <div className="mt-2 space-x-2">
           <button className="text-xs text-blue-600 hover:underline focus:outline-none" disabled>Set up Auto Top-up</button>
           <button className="text-xs text-blue-600 hover:underline focus:outline-none" disabled>Top-up Manually</button>
        </div>
      </div>

      {showAd && (
        <div className="mt-auto border-t border-gray-200 pt-3">
          <div className="bg-gray-100 p-3 rounded text-center text-sm text-gray-700">
            <p className="font-medium mb-1">Advertisement Placeholder</p>
            <p className="text-xs">This space can show relevant offers or integrations.</p>
            <button className="mt-2 text-xs text-blue-600 hover:underline focus:outline-none">
              {limitReached ? 'Top-up Now to Remove Ad' : 'Add Credit Card to Remove Ad'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};