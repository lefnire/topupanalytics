import React from 'react';
import { Link, Navigate } from 'react-router'; // Correct import, added Navigate
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';

const useStripe = import.meta.env.VITE_USE_STRIPE === 'true';

export default function PaymentSuccessPage() {
  if (!useStripe) {
    // Option 1: Redirect if Stripe is disabled (more robust)
    // return <Navigate to="/sites" replace />;

    // Option 2: Show an informative message
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Page Not Applicable</CardTitle>
            <CardDescription>
              Stripe payments are not enabled in this configuration.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button asChild>
              <Link to="/sites">Go to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Original content if Stripe is enabled
  return (
    <div className="flex justify-center items-center min-h-screen">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Payment Method Added!</CardTitle>
          <CardDescription>
            Your payment method has been successfully added and auto-pay is now active.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link to="/sites">Go to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}