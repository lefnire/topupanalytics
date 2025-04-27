import React, { useState, useEffect } from 'react';
import { useApiClient, type Site } from '../../lib/api';
import { toast } from 'sonner';
// Assuming lucide-react is available, otherwise replace with placeholder
import { Settings } from 'lucide-react';

// TODO: Define props if needed (e.g., onSiteSelect, onSettingsClick)
interface SiteSelectorDropdownContentProps {
  onSiteSelect?: (siteId: string) => void;
  onSettingsClick?: (siteId: string) => void;
}

export function SiteSelectorDropdownContent({ onSiteSelect, onSettingsClick }) { // Removed type annotation for debugging
  const { get } = useApiClient();
  const [sites, setSites] = useState<Site[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSites = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await get<Site[]>('/api/sites');
        setSites(data || []); // Handle potential null/undefined response
      } catch (err: any) {
        console.error("Failed to fetch sites:", err);
        const errorMessage = err.message || 'Failed to load sites.';
        setError(errorMessage);
        toast.error(errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSites();
  }, [get]);

  const handleSiteClick = (siteId: string) => {
    // TODO: Implement site switching logic
    console.log(`Site selected: ${siteId}`);
    onSiteSelect?.(siteId);
  };

  const handleSettingsClick = (e: React.MouseEvent, siteId: string) => {
    e.stopPropagation(); // Prevent triggering site selection
    // TODO: Implement opening SiteSettingsModal
    console.log(`Settings clicked for site: ${siteId}`);
    onSettingsClick?.(siteId);
  };

  if (isLoading) {
    return <div className="p-2 text-sm text-muted-foreground">Loading sites...</div>;
  }

  if (error) {
    return <div className="p-2 text-sm text-red-600">Error: {error}</div>;
  }

  if (sites.length === 0) {
    return <div className="p-2 text-sm text-muted-foreground">No sites found.</div>;
    // TODO: Consider adding a "Create New Site" option here?
  }

  return (
    <div className="flex flex-col">
      {sites.map((site) => (
        <div
          key={site.site_id}
          className="flex items-center justify-between p-2 hover:bg-accent rounded-md cursor-pointer text-sm"
          onClick={() => handleSiteClick(site.site_id)}
          role="menuitem"
          tabIndex={0} // Make it focusable
          onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? handleSiteClick(site.site_id) : null}
        >
          <span>{site.name}</span>
          <button
            onClick={(e) => handleSettingsClick(e, site.site_id)}
            className="p-1 rounded hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label={`Settings for ${site.name}`}
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
            {/* Placeholder: ⚙️ */}
          </button>
        </div>
      ))}
      {/* TODO: Add "Create New Site" button/link here? */}
    </div>
  );
}