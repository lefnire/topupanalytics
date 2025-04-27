import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom'; // Correct import for react-router-dom v6+
import { useApiClient, type Site } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext'; // Import useAuth
import ProtectedRoute from '../../components/ProtectedRoute'; // Import ProtectedRoute

function SitesListPageContent() {
  const { get } = useApiClient();
  const [sites, setSites] = useState<Site[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchSites = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await get<Site[]>('/api/sites');
        setSites(data || []); // Handle potential null/undefined response
      } catch (err: any) {
        console.error("Failed to fetch sites:", err);
        setError(err.message || 'Failed to load sites. Please try again.');
        toast.error(err.message || 'Failed to load sites.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchSites();
  }, [get]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Your Sites</CardTitle>
          <CardDescription>Manage your registered websites.</CardDescription>
        </div>
        <Button onClick={() => navigate('/sites/new')}>Create New Site</Button>
      </CardHeader>
      <CardContent>
        {isLoading && <p>Loading sites...</p>}
        {error && <p className="text-red-500">{error}</p>}
        {!isLoading && !error && sites.length === 0 && (
          <div className="text-center py-8">
            <p className="mb-4">No sites found. Get started by creating your first one!</p>
            <Button asChild>
              <Link to="/sites/new">Create Your First Site</Link>
            </Button>
          </div>
        )}
        {!isLoading && !error && sites.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Site ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((site) => (
                <TableRow key={site.site_id}>
                  <TableCell className="font-medium">{site.name}</TableCell>
                  <TableCell>{site.site_id}</TableCell>
                  <TableCell>{site.is_active ? 'Active' : 'Inactive'}</TableCell>
                  <TableCell>{new Date(site.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/sites/${site.site_id}`}>View Details</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}


// Wrap the component with ProtectedRoute
export default function SitesListPage() {
    return (
        <ProtectedRoute>
            <SitesListPageContent />
        </ProtectedRoute>
    );
}