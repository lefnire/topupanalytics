import React from 'react';
import { CreateSiteForm } from './components/CreateSiteForm';
import ProtectedRoute from '../../components/ProtectedRoute';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '../../components/ui/card';

function CreateSitePageContent() {
  return (
    <Card className="w-full max-w-2xl mx-auto"> {/* Center and limit width */}
      <CardHeader>
        <CardTitle>Create New Site</CardTitle>
        <CardDescription>
          Register a new website to start tracking analytics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CreateSiteForm />
      </CardContent>
    </Card>
  );
}

// Wrap the component with ProtectedRoute
export default function CreateSitePage() {
    return (
        <ProtectedRoute>
            <CreateSitePageContent />
        </ProtectedRoute>
    );
}