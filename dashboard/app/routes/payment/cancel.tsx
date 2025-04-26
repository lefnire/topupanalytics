import React from 'react';
import { Link } from 'react-router'; // Correct import
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';

export default function PaymentCancelPage() {
  return (
    <div className="flex justify-center items-center min-h-screen">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Payment Method Setup Cancelled</CardTitle>
          <CardDescription>
            The process to add a payment method was cancelled. Auto-pay has not been enabled.
            You can try setting up auto-pay again from the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild variant="outline">
            <Link to="/sites">Return to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}