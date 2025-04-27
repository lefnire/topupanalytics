import React from 'react';
import { CreateSiteForm } from '../../routes/sites/components/CreateSiteForm'; // Adjust path as needed
import { type Site } from '../../lib/api'; // Import Site type if needed for callback
import { DialogTitle, DialogDescription } from '../../components/ui/dialog'; // Added Dialog imports
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'; // Added VisuallyHidden import

interface AddSiteModalProps {
  onClose?: () => void; // Optional: For closing the modal
  onSiteCreated?: (newSite: Site) => void; // Optional: Callback after site creation
}

export function AddSiteModal({ onClose, onSiteCreated }: AddSiteModalProps) {

  // The CreateSiteForm likely handles navigation or calls a callback on success.
  // We might need to pass a specific callback to it if its default behavior
  // (like navigating) isn't suitable for a modal.
  // For now, assume CreateSiteForm can optionally take an `onSuccess` prop.

  const handleSuccess = (newSite: Site) => {
    onSiteCreated?.(newSite);
    // Optionally close the modal on success
    // onClose?.();
  };

  return (
    <div className="p-1"> {/* Adjust padding based on modal implementation */}
      <VisuallyHidden>
        <DialogTitle>Add New Site</DialogTitle>
        <DialogDescription>Register a new website to start tracking analytics.</DialogDescription>
      </VisuallyHidden>
      {/* Pass the success handler to the form */}
      <CreateSiteForm onSuccess={handleSuccess} />
      {/* Optional: Add Close button if modal doesn't provide one */}
      {/* <div className="flex justify-end pt-4">
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div> */}
    </div>
  );
}