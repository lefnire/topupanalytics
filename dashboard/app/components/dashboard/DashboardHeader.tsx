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
import { type DateRange } from 'react-day-picker';
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

// Helper function to calculate DateRange
const calculateDateRange = (period: string): DateRange => {
  const now = new Date();
  let fromDate = new Date();

  switch (period) {
    case '24 hours':
      fromDate.setDate(now.getDate() - 1);
      break;
    case '7 days':
      fromDate.setDate(now.getDate() - 7);
      break;
    case '30 days':
      fromDate.setDate(now.getDate() - 30);
      break;
    case '90 days':
      fromDate.setDate(now.getDate() - 90);
      break;
    default: // Default to 24 hours
      fromDate.setDate(now.getDate() - 1);
  }
  // Ensure 'from' is not after 'to' (can happen with clock changes near midnight)
  if (fromDate > now) {
    fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Set to exactly 24h ago if needed
  }
  return { from: fromDate, to: now };
};


export const DashboardHeader = () => {
  const timePeriods = ["24 hours", "7 days", "30 days", "90 days"];
  const [selectedPeriod, setSelectedPeriod] = useState<string>(timePeriods[0]); // Default to "24 hours"

  // Select state from HTTP store
  const {
    selectedSiteId,
    sites,
    httpStatus, // Renamed to avoid clash
    selectedRange,
    setSelectedSiteId,
    setSelectedRange,
    isAddSiteModalOpen,
    setAddSiteModalOpen,
    fetchSites,
  } = useHttpStore(useShallow((state: AnalyticsHttpState) => ({
    selectedSiteId: state.selectedSiteId,
    sites: state.sites,
    httpStatus: state.status,
    selectedRange: state.selectedRange,
    setSelectedSiteId: state.setSelectedSiteId,
    setSelectedRange: state.setSelectedRange,
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

  // Effect to select first site AND set initial date range
  useEffect(() => {
    // Select first site if none selected
    if (!selectedSiteId && sites.length > 0) {
      setSelectedSiteId(sites[0].site_id);
    }
    // Set initial date range on mount
    setSelectedRange(calculateDateRange(selectedPeriod));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, selectedSiteId, setSelectedSiteId]); // Keep original dependencies for site selection logic

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

  const handleTimePeriodChange = (value: string) => {
    if (timePeriods.includes(value)) { // Ensure value is one of the allowed periods
      setSelectedPeriod(value);
      setSelectedRange(calculateDateRange(value));
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
             <Select value={selectedPeriod} onValueChange={handleTimePeriodChange} disabled={isLoading || !selectedSiteId}>
               <SelectTrigger className="w-[180px]">
                 <SelectValue placeholder="Select time period" />
               </SelectTrigger>
               <SelectContent>
                 {timePeriods.map((period) => (
                   <SelectItem key={period} value={period}>
                     {period}
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