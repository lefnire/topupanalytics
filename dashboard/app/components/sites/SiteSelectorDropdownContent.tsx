import React from 'react';
import { useStore } from '../../stores/analyticsStore'; // Import the Zustand store
import { useShallow } from 'zustand/react/shallow'; // Import useShallow for performance
import { Settings } from 'lucide-react';
import { type Site } from '../../stores/analyticsTypes'; // Import Site type from store types

interface SiteSelectorDropdownContentProps {
  // onSiteSelect is no longer needed as selection is handled by the store's action
  onSettingsClick?: (siteId: string) => void;
  // Add a prop to close the dropdown after selection if needed
  closeDropdown?: () => void;
}

export function SiteSelectorDropdownContent({ onSettingsClick, closeDropdown }: SiteSelectorDropdownContentProps) {
  // Select necessary state and actions from the store
  const { sites, selectedSiteId, setSelectedSiteId, status, error } = useStore(
    useShallow(state => ({
      sites: state.sites,
      selectedSiteId: state.selectedSiteId,
      setSelectedSiteId: state.setSelectedSiteId,
      status: state.status,
      error: state.error,
    }))
  );

  // Determine loading state based on store status and site data
  // Sites might be empty initially before fetchSites completes, even if status isn't 'loading_data' yet.
  // Consider status 'initializing' or 'idle' before sites are populated as loading.
  const isLoading = (status === 'initializing' || status === 'idle') && sites.length === 0 && !error;

  const handleSiteClick = (siteId: string) => {
    console.log(`Site selected via dropdown: ${siteId}`);
    setSelectedSiteId(siteId); // Update the store's selected site
    closeDropdown?.(); // Close the dropdown if the function is provided
  };

  const handleSettingsClick = (e: React.MouseEvent, siteId: string) => {
    e.stopPropagation(); // Prevent triggering site selection
    console.log(`Settings clicked for site: ${siteId}`);
    onSettingsClick?.(siteId);
    closeDropdown?.(); // Close dropdown after opening settings modal
  };

  // Loading state based on store status and initial site load
  if (isLoading) {
    return <div className="p-2 text-sm text-muted-foreground">Loading sites...</div>;
  }

  // Error state from the store
  if (status === 'error' && error) {
    // Display a more specific error if available, otherwise generic
    const displayError = typeof error === 'string' ? error : 'Failed to load sites.';
    return <div className="p-2 text-sm text-red-600">Error: {displayError}</div>;
  }

  // No sites found after attempting to load (and no error occurred)
  if (sites.length === 0 && !isLoading) {
     return <div className="p-2 text-sm text-muted-foreground">No sites found.</div>;
     // TODO: Consider adding a "Create New Site" option here?
  }

  return (
    <div className="flex flex-col">
      {sites.map((site) => (
        <div
          key={site.site_id}
          // Highlight the currently selected site
          className={`flex items-center justify-between p-2 hover:bg-accent rounded-md cursor-pointer text-sm ${
            selectedSiteId === site.site_id ? 'bg-accent font-semibold' : ''
          }`}
          onClick={() => handleSiteClick(site.site_id)}
          role="menuitem"
          aria-selected={selectedSiteId === site.site_id} // Indicate selection for accessibility
          tabIndex={0} // Make it focusable
          onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? handleSiteClick(site.site_id) : null}
        >
          <span>{site.name || `Site ID: ${site.site_id.substring(0, 6)}...`}</span> {/* Provide fallback name */}
          <button
            onClick={(e) => handleSettingsClick(e, site.site_id)}
            className="p-1 rounded hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label={`Settings for ${site.name || 'this site'}`}
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      ))}
      {/* TODO: Add "Create New Site" button/link here? */}
    </div>
  );
}