import React, { useEffect } from 'react';
import { Navigate } from 'react-router'; // Import Navigate for redirection
import { useAuth } from '../contexts/AuthContext'; // Import the auth hook
import { useStore } from '../stores/analyticsStore';
// Keep Select imports for DashboardHeader (even though Header is separate, imports might be shared or needed indirectly) - NOTE: Removing the actual imports as they are unused in *this* file.

import { DashboardHeader } from '../components/dashboard/DashboardHeader'; // Import the new header component
import { DashboardContent } from '../components/dashboard/DashboardContent'; // Import the new content component


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
    // fetchAndLoadData now handles DB init and fetching sites if necessary
    useStore.getState().fetchAndLoadData();

    return () => { useStore.getState().cleanup(); }
    // Depend on endpoint to refetch if it changes
  }, []); // Empty dependency array ensures this runs only once on mount

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

  return <>
    <div className="min-h-screen bg-gray-100 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Use the new DashboardHeader component */}
        <DashboardHeader /> {/* Props are now fetched internally */}

        {/* Render the new DashboardContent component with no props */}
        <DashboardContent />

      </div>
    </div>
  </>;
};
