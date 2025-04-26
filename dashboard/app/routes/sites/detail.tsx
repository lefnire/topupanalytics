import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router'; // Use react-router for useParams and Link
import { useApiClient, type Site } from '../../lib/api';
import ProtectedRoute from '../../components/ProtectedRoute';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
// Import the components
import { SiteSettingsForm } from './components/SiteSettingsForm';
import { EmbedScriptDisplay } from './components/EmbedScriptDisplay';

function SiteDetailPageContent() {
  const { siteId } = useParams<{ siteId: string }>();
  const { get } = useApiClient();
  const [site, setSite] = useState<Site | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSiteDetails = async () => {
      if (!siteId) {
        setError("Site ID is missing from URL.");
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const data = await get<Site>(`/api/sites/${siteId}`);
        setSite(data);
      } catch (err: any) {
        console.error("Failed to fetch site details:", err);
        setError(err.message || `Failed to load site ${siteId}. Please try again.`);
        toast.error(err.message || `Failed to load site ${siteId}.`);
        setSite(null); // Clear site data on error
      } finally {
        setIsLoading(false);
      }
    };

    fetchSiteDetails();
  }, [get, siteId]);

  if (isLoading) {
    return <p>Loading site details...</p>;
  }

  if (error) {
    return <p className="text-red-500">{error}</p>;
  }

  if (!site) {
    return <p>Site not found.</p>;
  }

  // Function to update site state after successful form submission
  const handleSiteUpdate = (updatedSite: Site) => {
    setSite(updatedSite);
    // Update the CardTitle directly or let the re-render handle it
    // document.title = `Site: ${updatedSite.name}`; // Example if you want to update page title
  };


  return (
    <div className="space-y-6">
       <Button variant="outline" asChild>
           <Link to="/sites">&larr; Back to Sites List</Link>
       </Button>

      <Card>
        <CardHeader>
          <CardTitle>Site Details: {site.name}</CardTitle>
          <CardDescription>Site ID: {site.site_id}</CardDescription>
          {/* Add more details like created date, status etc. if desired */}
        </CardHeader>
        {/* Content can be added here if needed, or keep it minimal */}
      </Card>

      {/* Placeholder for Embed Script */}
      <Card>
        <CardHeader>
          <CardTitle>Embed Script</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Use the EmbedScriptDisplay component */}
          <EmbedScriptDisplay siteId={site.site_id} />
        </CardContent>
      </Card>

      {/* Settings Form */}
      <Card>
        <CardHeader>
          <CardTitle>Site Settings</CardTitle>
        </CardHeader>
        <CardContent>
           {/* Use the SiteSettingsForm component and pass the update handler */}
           <SiteSettingsForm site={site} onUpdate={handleSiteUpdate} />
        </CardContent>
      </Card>
    </div>
  );
}

// Wrap the component with ProtectedRoute
export default function SiteDetailPage() {
  return (
    <ProtectedRoute>
      <SiteDetailPageContent />
    </ProtectedRoute>
  );
}