import React, { useState, useEffect } from 'react';
import { useApiClient, type Site } from '../../lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card'; // Removed CardDescription import as DialogDescription will be used
import { DialogTitle, DialogDescription } from '../../components/ui/dialog'; // Added Dialog imports
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'; // Added VisuallyHidden import
import { toast } from 'sonner';
import { SiteSettingsForm } from '../../routes/sites/components/SiteSettingsForm'; // Adjust path as needed
import { EmbedScriptDisplay } from '../../routes/sites/components/EmbedScriptDisplay'; // Adjust path as needed

interface SiteSettingsModalProps {
  siteId: string;
  onClose?: () => void; // Optional: For closing the modal
  onSiteUpdate?: (updatedSite: Site) => void; // Optional: To notify parent of updates
}

export function SiteSettingsModal({ siteId, onClose, onSiteUpdate }: SiteSettingsModalProps) {
  const { get } = useApiClient();
  const [site, setSite] = useState<Site | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSiteDetails = async () => {
      if (!siteId) {
        // This case might not be necessary if siteId is always provided, but good practice
        setError("Site ID is required.");
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        // Fetch site details using the provided siteId prop
        const data = await get<Site>(`/api/sites/${siteId}`);
        setSite(data);
      } catch (err: any) {
        console.error("Failed to fetch site details:", err);
        const message = err.message || `Failed to load site ${siteId}. Please try again.`;
        setError(message);
        toast.error(message);
        setSite(null); // Clear site data on error
      } finally {
        setIsLoading(false);
      }
    };

    fetchSiteDetails();
  }, [get, siteId]); // Depend on siteId prop

  const handleSiteUpdate = (updatedSite: Site) => {
    setSite(updatedSite);
    onSiteUpdate?.(updatedSite); // Notify parent component if needed
    toast.success(`Site "${updatedSite.name}" updated successfully.`);
    // Consider if the modal should close automatically on update
    // onClose?.();
  };

  if (isLoading) {
    return <div className="p-4">Loading site details...</div>; // Simple loading state for modal
  }

  if (error) {
    return <div className="p-4 text-red-500">{error}</div>; // Simple error state for modal
  }

  if (!site) {
    // This might indicate an issue even if no error was thrown (e.g., 404)
    return <div className="p-4">Site not found or could not be loaded.</div>;
  }

  // Render content suitable for a modal
  return (
    <div className="space-y-4 p-1 max-h-[80vh] overflow-y-auto"> {/* Added max-height and overflow */}
      <VisuallyHidden>
        <DialogTitle>Site Settings</DialogTitle>
        <DialogDescription>View and manage settings for the {site.name} site, including configuration and embed script.</DialogDescription>
      </VisuallyHidden>
      {/* Display site name/ID prominently */}
       <h2 className="text-lg font-semibold">{site.name} Settings</h2>
       <p className="text-sm text-muted-foreground">Site ID: {site.site_id}</p>

      {/* Embed Script Section */}
      <Card>
        <CardHeader>
          <CardTitle>Embed Script</CardTitle>
        </CardHeader>
        <CardContent>
          <EmbedScriptDisplay siteId={site.site_id} />
        </CardContent>
      </Card>

      {/* Settings Form Section */}
      <Card>
        <CardHeader>
          <CardTitle>Site Configuration</CardTitle>
        </CardHeader>
        <CardContent>
           <SiteSettingsForm site={site} onUpdate={handleSiteUpdate} />
        </CardContent>
      </Card>

      {/* Optional: Add Close button if modal doesn't provide one */}
      {/* <div className="flex justify-end pt-4">
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div> */}
    </div>
  );
}