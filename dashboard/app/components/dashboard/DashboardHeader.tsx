import React, { useState, useMemo, useEffect } from 'react'; // Added useEffect
import { Avatar, AvatarImage, AvatarFallback } from '~/components/ui/avatar'; // Use path alias
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import { Button } from '../ui/button';
import { Calendar as CalendarIcon, User, LogOut, PlusCircle } from 'lucide-react'; // Added icons
import { cn } from '../../lib/utils';
import { format } from 'date-fns';
import { useStore, type AnalyticsState } from '../../stores/analyticsStore';
import type { Segment, Site } from '../../stores/analyticsTypes'; // Added Site import
// Removed the old import line, it was combined into the line above
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
} from '../ui/dropdown-menu'; // Use relative path
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

export const DashboardHeader = () => {
  const {
    selectedSiteId,
    sites,
    status,
    isRefreshing,
    segments,
    selectedRange,
    setSelectedSiteId,
    removeSegment,
    clearSegments,
    setSelectedRange,
    isAddSiteModalOpen, // Added from store
    setAddSiteModalOpen, // Added from store
  } = useStore(useShallow((state: AnalyticsState) => ({
    selectedSiteId: state.selectedSiteId,
    sites: state.sites,
    status: state.status,
    isRefreshing: state.isRefreshing,
    segments: state.segments,
    selectedRange: state.selectedRange,
    setSelectedSiteId: state.setSelectedSiteId,
    removeSegment: state.removeSegment,
    clearSegments: state.clearSegments,
    setSelectedRange: state.setSelectedRange,
    isAddSiteModalOpen: state.isAddSiteModalOpen, // Added selector
    setAddSiteModalOpen: state.setAddSiteModalOpen, // Added selector
  })));

  const { user, logout } = useAuth();

  // State for modals (Removed AddSiteModal state)
  const [isSiteSettingsModalOpen, setIsSiteSettingsModalOpen] = useState(false);
  // const [isAddSiteModalOpen, setIsAddSiteModalOpen] = useState(false); // Removed, now using store
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [selectedSiteIdForModal, setSelectedSiteIdForModal] = useState<string | null>(null);

  // Derive isLoading state locally based on status
  const isLoading = status === 'initializing' || status === 'loading_data' || status === 'aggregating';

  // Select the first site if none is selected and sites exist
  useEffect(() => {
    if (!selectedSiteId && sites.length > 0) {
      setSelectedSiteId(sites[0].site_id);
    }
  }, [sites, selectedSiteId, setSelectedSiteId]);

  // Derive selectedSite for display purposes
  const selectedSite = useMemo(() => sites.find((site: Site) => site.site_id === selectedSiteId), [sites, selectedSiteId]); // Added Site type

  // Determine the text for the dropdown trigger (Simplified Logic)
  const dropdownTriggerText = useMemo(() => {
    // If sites are loaded and we have a selected one, show its name
    if (selectedSite) return selectedSite.name;
    // If sites are loaded, but none is selected yet (e.g., initial load), show the first site's name
    if (sites.length > 0 && !selectedSiteId) return sites[0].name;
    // If sites are loaded but the array is empty
    if (sites.length === 0 && status !== 'initializing' && status !== 'loading_data') return "No Sites Found";
    // If still loading sites (or analytics, as status is shared)
    if (isLoading) return "Loading..."; // Generic loading
    // If there was an error (could be site fetch or analytics fetch)
    if (status === 'error') return "Error"; // Generic error
    // Default fallback
    return "Admin";
  }, [selectedSite, sites, selectedSiteId, isLoading, status]);


  const handleOpenSiteSettings = (siteId: string) => {
    setSelectedSiteIdForModal(siteId);
    setIsSiteSettingsModalOpen(true);
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
                 <Button variant="ghost" className="flex items-center gap-2 px-2 py-1 h-auto rounded-md">
                   <Avatar className="h-6 w-6">
                     {/* <AvatarImage src={user?.avatarUrl} alt={user?.name} /> */}
                     <AvatarFallback className="text-xs">A</AvatarFallback> {/* Static "A" for now */}
                   </Avatar>
                   <span className="text-sm font-medium">{dropdownTriggerText}</span>
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

             {/* Date Range Picker */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  id="date"
                  variant={"outline"}
                  className={cn(
                    "w-[260px] justify-start text-left font-normal",
                    !selectedRange && "text-muted-foreground"
                  )}
                  disabled={isLoading || !selectedSiteId} // Disable if loading or no site selected
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {selectedRange?.from ? (
                    selectedRange.to ? (
                      <>
                        {format(selectedRange.from, "LLL dd, y")} -{" "}
                        {format(selectedRange.to, "LLL dd, y")}
                      </>
                    ) : (
                      format(selectedRange.from, "LLL dd, y")
                    )
                  ) : (
                    <span>Pick a date</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  initialFocus
                  mode="range"
                  defaultMonth={selectedRange?.from}
                  selected={selectedRange}
                  onSelect={setSelectedRange} // Use store action directly
                  numberOfMonths={2}
                  disabled={(date) => date > new Date() || date < new Date("2000-01-01")} // Example disabled dates
                />
              </PopoverContent>
            </Popover>

             {/* Refresh Indicator */}
             {isRefreshing && <span className="text-xs text-gray-400 animate-pulse">(syncing...)</span>}
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
               // onSiteCreated={handleSiteCreated} // Optional: Handle creation
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