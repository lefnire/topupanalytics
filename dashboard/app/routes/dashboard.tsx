import React, { useEffect } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '~/contexts/AuthContext';
// Remove import for old useStore
import { useSqlStore } from '~/stores/analyticsSqlStore'; // Import the SQL store for cleanup
// Keep Select imports for DashboardHeader...

import { DashboardHeader } from '~/components/dashboard/DashboardHeader';
import { DashboardContent } from '~/components/dashboard/DashboardContent'; // Import the new content component


// --- Constants ---
const isServer = typeof window === 'undefined'; // Re-added isServer definition
// --- Helper Functions ---

// --- Helper Functions ---
// formatNumber is now defined in BaseCard.tsx and EventsCard.tsx

 // ===================== Generic Card machinery =====================
// CardMeta, CARD_META, and CardContainer moved to ../components/dashboard/CardContainer.tsx

// -----------------------------------------------------------------

// EventsCard component moved to ../components/dashboard/EventsCard.tsx



// --- Main Dashboard Component ---

export default function AnalyticsDashboard() {
  // --- Auth State ---
  const { isAuthenticated, isLoading: isAuthLoading, logout, user } = useAuth();

  // --- Analytics Store State (Removed hook call) ---
  // State and derived values are now handled within DashboardContent

  useEffect(() => {
    if (isServer) return;
    // No need to explicitly call fetchAndLoadData here.
    // analyticsHttpStore handles initial site fetch on rehydration.
    // analyticsSqlStore handles DB init and fetches data via subscription.

    // Cleanup function should now call the SQL store's cleanup
    return () => { useSqlStore.getState().cleanup(); }
  }, []);

  // Removed dbInitError check (handled in DashboardContent)

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

  // --- DB Init Error Check (Removed - Handled in DashboardContent) ---

  // --- Stripe Integration Callbacks --- (Moved to DashboardContent)

  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
    {/* Use the new DashboardHeader component */}
    <DashboardHeader /> {/* Props are now fetched internally */}

    {/* Render the new DashboardContent component with no props */}
    <DashboardContent />
  </div>;
};
