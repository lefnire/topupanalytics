import React, { useState } from 'react';
import { Button } from '../ui/button'; // Corrected path relative to components/account/
import { toast } from 'sonner';
// Import useApiClient if needed for future direct API calls from modal
// import { useApiClient } from '../../lib/api';

// Check Stripe status at the module level
const useStripe = import.meta.env.VITE_USE_STRIPE === 'true';

// Define possible billing statuses - parent component will determine this
type BillingStatus = 'active' | 'inactive' | 'cancelled' | 'not_setup' | 'loading' | 'error';

interface AccountModalProps {
  userEmail: string;
  billingStatus: BillingStatus; // Status determined and passed by parent
  onClose?: () => void;
  // Callback provided by parent to initiate Stripe checkout
  onSetupBilling?: () => Promise<void>;
  // Callback provided by parent to open Stripe portal
  onManageBilling?: () => Promise<void>;
}

export function AccountModal({
  userEmail,
  billingStatus,
  onClose,
  onSetupBilling,
  onManageBilling
}: AccountModalProps) {
  const [isBillingActionLoading, setIsBillingActionLoading] = useState(false);

  // Handler to call the parent's setup billing function
  const handleSetupBilling = async () => {
    if (!onSetupBilling) return;
    setIsBillingActionLoading(true);
    try {
      await onSetupBilling();
      // Parent handles redirection or UI update
    } catch (error: any) {
      toast.error(`Failed to initiate billing setup: ${error.message || 'Unknown error'}`);
    } finally {
      setIsBillingActionLoading(false);
    }
  };

  // Handler to call the parent's manage billing function
  const handleManageBilling = async () => {
    if (!onManageBilling) return;
    setIsBillingActionLoading(true);
    try {
      await onManageBilling();
      // Parent handles redirection or UI update
    } catch (error: any) {
      toast.error(`Failed to open billing portal: ${error.message || 'Unknown error'}`);
    } finally {
      setIsBillingActionLoading(false);
    }
  };

  // Render billing info based on the status prop
  const renderBillingInfo = () => {
    switch (billingStatus) {
      case 'loading':
        return <p className="text-sm text-muted-foreground">Loading billing status...</p>;
      case 'active':
        return (
          <div className="space-y-2">
            <p className="text-sm text-green-600">✓ Auto-pay is active.</p>
            {onManageBilling && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleManageBilling}
                disabled={isBillingActionLoading}
              >
                {isBillingActionLoading ? 'Redirecting...' : 'Manage Billing'}
              </Button>
            )}
          </div>
        );
      case 'inactive':
      case 'cancelled':
        return (
          <div className="space-y-2">
            <p className="text-sm text-orange-600">⚠ Auto-pay is not active.</p>
            {onSetupBilling && (
               <Button
                 size="sm"
                 onClick={handleSetupBilling}
                 disabled={isBillingActionLoading}
               >
                 {isBillingActionLoading ? 'Redirecting...' : 'Setup Auto-Pay'}
               </Button>
            )}
             {onManageBilling && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleManageBilling}
                disabled={isBillingActionLoading}
                className="ml-2" // Add some space
              >
                {isBillingActionLoading ? 'Redirecting...' : 'Manage Billing'}
              </Button>
            )}
          </div>
        );
      case 'not_setup':
        // Use the module-level variable
        if (!useStripe) {
             return <p className="text-sm text-muted-foreground">Billing is not enabled in this configuration.</p>;
        }
        return (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Auto-pay has not been set up.</p>
            {onSetupBilling && (
               <Button
                 size="sm"
                 onClick={handleSetupBilling}
                 disabled={isBillingActionLoading}
               >
                 {isBillingActionLoading ? 'Redirecting...' : 'Setup Auto-Pay'}
               </Button>
            )}
          </div>
        );
      case 'error':
         return <p className="text-sm text-red-600">Could not load billing status.</p>;
      default:
        // Should not happen with defined types, but good practice
        return <p className="text-sm text-muted-foreground">Billing status unknown.</p>;
    }
  };

  return (
    <div className="p-1 space-y-4"> {/* Adjust padding based on modal */}
      <h2 className="text-lg font-semibold">Account</h2>
      <div>
        <p className="text-sm font-medium text-muted-foreground">Email</p>
        <p className="text-sm">{userEmail || 'N/A'}</p>
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">Billing</p>
        <div className="mt-1">
          {renderBillingInfo()}
        </div>
      </div>
       {/* Optional: Add Close button if modal doesn't provide one */}
       {/* <div className="flex justify-end pt-2">
         <Button variant="outline" onClick={onClose}>Close</Button>
       </div> */}
    </div>
  );
}