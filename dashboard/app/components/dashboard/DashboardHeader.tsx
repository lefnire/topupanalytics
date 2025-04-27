import React, { useMemo } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import { Button } from '../ui/button';
import { Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { format } from 'date-fns';
// Removed unused Site import
import { useStore, type AnalyticsState } from '../../stores/analyticsStore'; // Import Zustand hooks and state type
import type { Segment } from '../../stores/analyticsTypes'; // Import Segment type separately
import { useShallow } from 'zustand/shallow'; // Import useShallow from zustand
import { type DateRange } from 'react-day-picker';
import { useAuth } from '../../contexts/AuthContext'; // Import useAuth


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
  } = useStore(useShallow((state: AnalyticsState) => ({ // Add type annotation here
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
  }))); // Add type annotation for state

  const { user, logout } = useAuth();

  // Derive isLoading state locally based on status
  const isLoading = status === 'initializing' || status === 'loading_data' || status === 'aggregating';

  // Derive selectedSite inside the component for the avatar
  const selectedSite = useMemo(() => sites.find(site => site.site_id === selectedSiteId), [sites, selectedSiteId]);

  return (
    <header className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      {/* Left Side: Site Selector and Segments */}
      <div className="flex flex-col items-start gap-2">
          {/* Site Selector */}
          <Select
              value={selectedSiteId ?? ''}
              onValueChange={(value) => setSelectedSiteId(value || null)}
              disabled={sites.length === 0 || isLoading || isRefreshing} // Disable while loading/refreshing
          >
              <SelectTrigger className="w-auto min-w-[180px] h-9 text-lg font-semibold border-none shadow-none focus:ring-0 p-0 gap-2">
                  <div className="flex items-center gap-2">
                       {/* Avatar */}
                       <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold ${selectedSite ? 'bg-blue-500' : 'bg-gray-400'}`}>
                           {selectedSite?.name?.charAt(0).toUpperCase() || '?'}
                       </div>
                       {/* Site Name */}
                       <SelectValue placeholder="Select a site..." />
                  </div>
              </SelectTrigger>
              <SelectContent>
                  {sites.length > 0 ? (
                      sites.map((site) => (
                          <SelectItem key={site.site_id} value={site.site_id}>
                              {site.name} ({site.site_id}) {/* Display name and ID */}
                          </SelectItem>
                      ))
                  ) : (
                      <SelectItem value="loading" disabled>
                        {status === 'error' ? 'Error loading sites' : 'Loading sites...'}
                      </SelectItem>
                  )}
              </SelectContent>
          </Select>
          {/* Segment Display Area */}
          {segments.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-1">
                  {segments.map((segment, index) => (
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
                  {/* Optional: Add a "Clear All" button */}
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
      </div>

      {/* Right Side: Date Range Picker & Logout */}
      <div className="flex items-center gap-4 text-sm text-gray-600 flex-shrink-0">
          {/* Refresh Indicator */}
          {isRefreshing && <span className="text-xs text-gray-400 animate-pulse">(syncing...)</span>}
          {/* User Info & Logout */}
          {user && (
            <span className="text-xs text-gray-500 hidden sm:inline">
              Logged in as: {user.username}
            </span>
          )}
          <Button onClick={logout} variant="outline" size="sm">Logout</Button>
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
      </div>
    </header>
  );
};