import React, { useState, useMemo, useEffect } from 'react'; // Added useEffect
import { Avatar, AvatarImage, AvatarFallback } from '~/components/ui/avatar'; // Use path alias
// Removed Popover, Calendar, Button, CalendarIcon, cn, format imports as they are replaced by Select
import { Button } from '../ui/button'; // Keep Button for DropdownMenuTrigger
import { User, LogOut, PlusCircle } from 'lucide-react';
// Import from new stores
import { useHttpStore, type AnalyticsHttpState } from '../../stores/analyticsHttpStore';
import { useSqlStore, type AnalyticsSqlState } from '../../stores/analyticsSqlStore';
import type { Segment, Site } from '../../stores/analyticsTypes';
import { useShallow } from 'zustand/shallow';
// import { type DateRange } from 'react-day-picker'; // No longer directly used here
import { useAuth } from '../../contexts/AuthContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { // Import Select components
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { SiteSelectorDropdownContent } from '../sites/SiteSelectorDropdownContent'; // Added SiteSelectorDropdownContent
import { SiteSettingsModal } from '../sites/SiteSettingsModal'; // Added SiteSettingsModal
import { AddSiteModal } from '../sites/AddSiteModal'; // Added AddSiteModal
import { AccountModal } from '../account/AccountModal'; // Added AccountModal

// calculateDateRange function is removed as it's no longer used here.
// The analyticsHttpStore.getSelectedDateRangeObject() is the source of truth for DateRange objects.

const timePeriodOptions = [
  { key: "today", display: "Today" },
  { key: "7days", display: "Last 7 days" },
  { key: "30days", display: "Last 30 days" },
  { key: "90days", display: "Last 90 days" },
  // Add other options if DashboardHeader should support them, e.g.:
  // { key: "yesterday", display: "Yesterday" },
  // { key: "6months", display: "Last 6 months" },
  // { key: "12months", display: "Last 12 months" },
];
const defaultHeaderRangeKey = "7days"; // Default for this component if store is invalid/empty

export const DashboardHeader = () => {
  // Local state for the dropdown, initialized from store or a default valid for this header
  const [currentSelectedKey, setCurrentSelectedKey] = useState<string>(() => {
    const initialStoreKey = useHttpStore.getState().selectedRangeKey;
    return timePeriodOptions.some(opt => opt.key === initialStoreKey) ? initialStoreKey : defaultHeaderRangeKey;
  });

  // Select state from HTTP store
  const {
    selectedSiteId,
    sites,
    httpStatus, // Renamed to avoid clash
    // selectedRange, // No longer needed
    selectedRangeKeyFromStore,
    setSelectedSiteId,
    // setSelectedRange, // No longer needed
    setSelectedRangeKeyAction,
    isAddSiteModalOpen,
    setAddSiteModalOpen,
    fetchSites,
  } = useHttpStore(useShallow((state: AnalyticsHttpState) => ({
    selectedSiteId: state.selectedSiteId,
    sites: state.sites,
    httpStatus: state.status,
    // selectedRange: state.selectedRange, // Removed
    selectedRangeKeyFromStore: state.selectedRangeKey,
    setSelectedSiteId: state.setSelectedSiteId,
    // setSelectedRange: state.setSelectedRange, // Removed
    setSelectedRangeKeyAction: state.setSelectedRangeKey,
    isAddSiteModalOpen: state.isAddSiteModalOpen,
    setAddSiteModalOpen: state.setAddSiteModalOpen,
    fetchSites: state.fetchSites,
  })));

  // Select state from SQL store
  const {
    sqlStatus, // Renamed to avoid clash
    // isRefreshing, // Removed
    segments,
    removeSegment,
    clearSegments,
  } = useSqlStore(useShallow((state: AnalyticsSqlState) => ({
    sqlStatus: state.status,
    // isRefreshing: state.isRefreshing, // Removed
    segments: state.segments,
    removeSegment: state.removeSegment,
    clearSegments: state.clearSegments,
  })));

  const { user, logout } = useAuth();

  // Handler for when a site is successfully created
  const handleSiteCreated = () => {
    fetchSites(); // Refresh the site list
  };

  // State for modals (Removed AddSiteModal state)
  const [isSiteSettingsModalOpen, setIsSiteSettingsModalOpen] = useState(false);
  // const [isAddSiteModalOpen, setIsAddSiteModalOpen] = useState(false); // Removed, now using store
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [selectedSiteIdForModal, setSelectedSiteIdForModal] = useState<string | null>(null);

  // Derive combined loading and error states locally
  const isLoadingHttp = httpStatus === 'fetching_sites';
  const isLoadingSql = sqlStatus === 'initializing' || sqlStatus === 'loading_data' || sqlStatus === 'aggregating';
  const isLoading = isLoadingHttp || isLoadingSql;
  const isError = httpStatus === 'error' || sqlStatus === 'error';

  // Effect to select first site if none selected
  useEffect(() => {
    if (!selectedSiteId && sites.length > 0) {
      setSelectedSiteId(sites[0].site_id);
    }
  }, [sites, selectedSiteId, setSelectedSiteId]);

  // Effect to synchronize local currentSelectedKey with store's selectedRangeKey
  // and ensure store has a valid key for this header's options
  useEffect(() => {
    const storeKey = selectedRangeKeyFromStore;
    const isValidStoreKeyForHeader = timePeriodOptions.some(opt => opt.key === storeKey);

    if (isValidStoreKeyForHeader) {
      // Store key is valid for this header's dropdown, ensure local state matches
      if (currentSelectedKey !== storeKey) {
        setCurrentSelectedKey(storeKey);
      }
    } else {
      // Store key is NOT valid for this header (e.g., "6months", "allTime") or is undefined.
      // The header should set the store to its current local key (which is guaranteed to be valid for the header).
      // This also handles the initial mount case if the store's key was not one of the header's options.
      if (storeKey !== currentSelectedKey) {
        setSelectedRangeKeyAction(currentSelectedKey);
      }
    }
    // Adding timePeriodOptions to dependencies, though it's stable, to be explicit.
  }, [selectedRangeKeyFromStore, setSelectedRangeKeyAction, currentSelectedKey, sites]); // Added sites to re-evaluate if httpStore.selectedRangeKey was default and sites load

  // Derive selectedSite for display purposes
  const selectedSite = useMemo(() => sites.find((site: Site) => site.site_id === selectedSiteId), [sites, selectedSiteId]); // Added Site type

  // Determine the text for the dropdown trigger (Simplified Logic)
  const dropdownTriggerText = useMemo(() => {
    // If sites are loaded and we have a selected one, show its name
    if (selectedSite) return selectedSite.name;
    // If sites are loaded, but none is selected yet (e.g., initial load), show the first site's name
    if (sites.length > 0 && !selectedSiteId) return sites[0].name;
    // If sites are loaded but the array is empty (check HTTP status specifically)
    if (sites.length === 0 && httpStatus === 'idle' && !isLoadingSql) return "No Sites Found";
    // If still loading (either HTTP or SQL)
    if (isLoading) return "Loading...";
    // If there was an error (either HTTP or SQL)
    if (isError) return "Error";
    // Default fallback
    return "Admin";
  }, [selectedSite, sites, selectedSiteId, isLoading, isError, httpStatus, isLoadingSql]);


  const handleOpenSiteSettings = (siteId: string) => {
    setSelectedSiteIdForModal(siteId);
    setIsSiteSettingsModalOpen(true);
  };

  const handleTimePeriodChange = (newKey: string) => {
    // Ensure the newKey is one of the valid options defined in timePeriodOptions
    if (timePeriodOptions.some(option => option.key === newKey)) {
      setCurrentSelectedKey(newKey); // Update local UI state immediately
      setSelectedRangeKeyAction(newKey); // Update the central store
    } else {
      console.warn(`DashboardHeader: Attempted to set invalid time period key: ${newKey}`);
    }
  };

  return (
    <>
      <header className="mb-6 flex items-center justify-between gap-4">
        {/* Left Side: User/Site Dropdown */}
        <div className="flex items-center gap-2">
             {/* User Dropdown Menu */}
             <DropdownMenu>
               <DropdownMenuTrigger asChild>
                 {/* Use Avatar and dynamic text */}
                 <Button variant="ghost" className="flex items-center gap-2 px-2 py-1 h-auto rounded-md"> {/* Removed text span from button */}
                   <Avatar className="h-6 w-6">
                     {/* <AvatarImage src={user?.avatarUrl} alt={user?.name} /> */}
                     <AvatarFallback className="text-xs">A</AvatarFallback> {/* Static "A" for now */}
                   </Avatar>
                 </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="start" className="w-56"> {/* Align start for left positioning */}
                 <DropdownMenuLabel>Sites</DropdownMenuLabel>
                 {/* Pass only required callbacks, assuming component handles data internally */}
                 <SiteSelectorDropdownContent
                   // onSiteSelect={setSelectedSiteId} // Removed: Component uses store action directly
                   onSettingsClick={handleOpenSiteSettings}
                 />
                  <DropdownMenuItem onSelect={() => setAddSiteModalOpen(true)}> {/* Use store action */}
                   <PlusCircle className="mr-2 h-4 w-4" />
                   <span>Add New Site</span>
                 </DropdownMenuItem>
                 <DropdownMenuSeparator />
                 <DropdownMenuItem onSelect={() => setIsAccountModalOpen(true)}>
                   <User className="mr-2 h-4 w-4" />
                   <span>Account</span>
                   {/*{user?.username && <span className="ml-auto text-xs text-muted-foreground">{user.username}</span>}*/}
                 </DropdownMenuItem>
                 <DropdownMenuItem onSelect={logout}>
                   <LogOut className="mr-2 h-4 w-4" />
                   <span>Logout</span>
                 </DropdownMenuItem>
               </DropdownMenuContent>
             </DropdownMenu>
             {/* Display Site Name next to Avatar Dropdown */}
             <span className="text-sm font-medium">{dropdownTriggerText}</span>
        </div>

        {/* Right Side: Segments, Date Range Picker & Refresh */}
        <div className="flex items-center gap-4 text-sm text-gray-600 flex-shrink-0">
             {/* Segment Display Area */}
             {segments.length > 0 && (
                 <div className="flex flex-wrap items-center gap-2">
                     {segments.map((segment: Segment, index: number) => ( // Added Segment and number types
                         <span key={index} className="flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-medium px-2 py-0.5 rounded-full">
                             {segment.label}
                             <button
                                 onClick={() => removeSegment(segment)}
                                 className="ml-1 text-blue-600 hover:text-blue-800 focus:outline-none"
                                 aria-label={`Remove filter: ${segment.label}`}
                                 title={`Remove filter: ${segment.label}`}
                             >
                                 &times; {/* Cross icon */}
                             </button>
                         </span>
                     ))}
                     {segments.length > 1 && (
                         <button
                             onClick={clearSegments}
                             className="text-xs text-gray-500 hover:text-gray-700 underline focus:outline-none ml-1"
                             title="Clear all filters"
                         >
                             Clear all
                         </button>
                     )}
                 </div>
             )}

             {/* Time Period Select Dropdown */}
             <Select value={currentSelectedKey} onValueChange={handleTimePeriodChange} disabled={isLoading || !selectedSiteId}>
               <SelectTrigger className="w-[180px]">
                 <SelectValue placeholder="Select time period" />
               </SelectTrigger>
               <SelectContent>
                 {timePeriodOptions.map((option) => (
                   <SelectItem key={option.key} value={option.key}>
                     {option.display}
                   </SelectItem>
                 ))}
               </SelectContent>
             </Select>

             {/* Refresh Indicator - Show when loading or aggregating */}
             {(sqlStatus === 'loading_data' || sqlStatus === 'aggregating') && <span className="text-xs text-gray-400 animate-pulse">(syncing...)</span>}
        </div>
      </header>

      {/* Modals wrapped in Dialog components */}
      <Dialog open={isSiteSettingsModalOpen} onOpenChange={setIsSiteSettingsModalOpen}>
        <DialogContent className="sm:max-w-[600px]"> {/* Adjust width as needed */}
          {/* Render SiteSettingsModal only when siteId is available and modal is open */}
          {selectedSiteIdForModal && isSiteSettingsModalOpen && (
            <SiteSettingsModal
              siteId={selectedSiteIdForModal}
              onClose={() => setIsSiteSettingsModalOpen(false)} // Optional: Pass close handler
              // onSiteUpdate={handleSiteUpdate} // Optional: Handle updates if needed
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={isAddSiteModalOpen} onOpenChange={setAddSiteModalOpen}> {/* Use store state/action */}
        <DialogContent className="sm:max-w-[425px]"> {/* Adjust width as needed */}
           <DialogHeader>
             <DialogTitle>Add New Site</DialogTitle>
           </DialogHeader>
           {/* Render AddSiteModal only when modal is open */}
           {isAddSiteModalOpen && ( // Use store state
             <AddSiteModal
               onClose={() => setAddSiteModalOpen(false)} // Use store action
               onSiteCreated={handleSiteCreated} // Handle creation
             />
           )}
        </DialogContent>
      </Dialog>

      <Dialog open={isAccountModalOpen} onOpenChange={setIsAccountModalOpen}>
         <DialogContent className="sm:max-w-[425px]"> {/* Adjust width as needed */}
           <DialogHeader>
             <DialogTitle>Account</DialogTitle>
           </DialogHeader>
           {/* Render AccountModal only when modal is open and user exists */}
           {isAccountModalOpen && user && (
             <AccountModal
               userEmail={user.username} // Pass required email
               billingStatus={'loading'} // Pass placeholder status - TODO: Get actual status
               onClose={() => setIsAccountModalOpen(false)} // Pass close handler
               // onSetupBilling={...} // TODO: Implement if needed
               // onManageBilling={...} // TODO: Implement if needed
             />
           )}
         </DialogContent>
      </Dialog>
    </>
  );
};