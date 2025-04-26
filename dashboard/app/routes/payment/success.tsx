import React from 'react';
import { Link } from 'react-router'; // Correct import
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';

export default function PaymentSuccessPage() {
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