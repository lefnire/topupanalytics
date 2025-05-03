import { create } from "zustand";
import { persist, createJSONStorage } from 'zustand/middleware';
import { type DateRange } from 'react-day-picker';
import { subDays, startOfDay, endOfDay, isValid, parseISO } from 'date-fns';

// Import types
import { type Site, type UserPreferences } from '../lib/api'; // Assuming types are here based on analyticsTypes.ts
import { fetchSitesAndPreferences } from './analyticsApi'; // API function

// Define status types specific to this store
export type HttpStoreStatus = 'idle' | 'fetching_sites' | 'error';

// Define the state structure for the HTTP store
export interface AnalyticsHttpState {
  status: HttpStoreStatus;
  error: string | null;
  sites: Site[];
  selectedSiteId: string | null;
  userPreferences: UserPreferences | null;
  selectedRange: DateRange | undefined;
  isAddSiteModalOpen: boolean;

  // Card Tab Preferences
  sourcesTab: string;
  pagesTab: string;
  regionsTab: string;
  devicesTab: string;
  eventsTab: string;

  // Actions
  fetchSites: () => Promise<void>;
  setSelectedSiteId: (siteId: string | null) => void;
  setSelectedRange: (range: DateRange | undefined) => void;
  setAddSiteModalOpen: (isOpen: boolean) => void;
  setSourcesTab: (tab: string) => void;
  setPagesTab: (tab: string) => void;
  setRegionsTab: (tab: string) => void;
  setDevicesTab: (tab: string) => void;
  setEventsTab: (tab: string) => void;
  resetHttpState: () => Partial<AnalyticsHttpState>; // Renamed for clarity
}

// Define the initial state for the HTTP store
const initialHttpState: Pick<AnalyticsHttpState,
  'status' | 'error' | 'sites' | 'selectedSiteId' | 'userPreferences' |
  'selectedRange' | 'isAddSiteModalOpen' | 'sourcesTab' | 'pagesTab' |
  'regionsTab' | 'devicesTab' | 'eventsTab'
> = {
  status: 'idle',
  error: null,
  sites: [],
  selectedSiteId: null,
  userPreferences: null,
  selectedRange: { // Default to last 7 days
    from: subDays(startOfDay(new Date()), 6),
    to: endOfDay(new Date()),
  },
  isAddSiteModalOpen: false,
  sourcesTab: 'channels',
  pagesTab: 'topPages',
  regionsTab: 'countries',
  devicesTab: 'browsers',
  eventsTab: 'events',
};

// --- Zustand Store ---
export const useHttpStore = create<AnalyticsHttpState>()(
  persist(
    (set, get) => ({
      ...initialHttpState,

      // --- Actions ---

      resetHttpState: () => ({
        // Reset only error, keep other state like sites, selectedId, range, tabs
        error: null,
        status: 'idle', // Reset status unless fetching
      }),

      setSelectedRange: (range: DateRange | undefined) => {
        if (JSON.stringify(range) === JSON.stringify(get().selectedRange)) return;
        console.log("HTTP Store: Setting selected range", range);
        set({
          selectedRange: range,
          error: null, // Clear potential previous errors
          status: 'idle',
        });
        // Note: SQL store will react to this change via subscription
      },

      setSelectedSiteId: (siteId: string | null) => {
        if (siteId === get().selectedSiteId) return;
        console.log(`HTTP Store: Setting selected site ID to: ${siteId}`);
        set({
          selectedSiteId: siteId,
          error: null, // Clear potential previous errors
          status: 'idle',
        });
        // Note: SQL store will react to this change via subscription
        // If no site is selected, the SQL store should handle its state accordingly (e.g., clear data)
      },

      fetchSites: async () => {
        console.log("HTTP Store: fetchSites called.");
        if (get().status === 'fetching_sites') return; // Prevent concurrent fetches

        set({ status: 'fetching_sites', error: null });
        try {
          const { sites: fetchedSites, preferences: fetchedPreferences } = await fetchSitesAndPreferences();

          set(state => {
            const currentSelectedId = state.selectedSiteId;
            // Auto-select first site if none selected or previous selection invalid
            const newSelectedSiteId = (!currentSelectedId || !fetchedSites.some(s => s.site_id === currentSelectedId)) && fetchedSites.length > 0
              ? fetchedSites[0].site_id
              : currentSelectedId;

            console.log("HTTP Store: Sites fetched", { count: fetchedSites.length, newSelectedSiteId });

            // Determine if modal should open
            const shouldOpenModal = fetchedSites.length === 0;
            if (shouldOpenModal) {
              console.log("HTTP Store: No sites found, opening Add Site modal.");
            }

            return {
              sites: fetchedSites,
              userPreferences: fetchedPreferences,
              selectedSiteId: newSelectedSiteId,
              status: 'idle',
              error: fetchedSites.length === 0 && !shouldOpenModal ? 'No sites found for this user.' : null,
              isAddSiteModalOpen: shouldOpenModal, // Set modal state based on fetch result
            };
          });

          // If a site is now selected (either pre-existing or newly auto-selected),
          // the SQL store's subscriber will pick it up.
          // If no sites exist, the modal is opened by the 'set' call above.

        } catch (err: any) {
          console.error("HTTP Store: Failed to fetch sites or preferences:", err);
          set({ status: 'error', error: err.message || 'Failed to fetch sites', sites: [], userPreferences: null, selectedSiteId: null });
        }
      },

      // --- Simple Setters ---
      setAddSiteModalOpen: (isOpen: boolean) => {
        console.log(`HTTP Store: Setting Add Site Modal open state to: ${isOpen}`);
        set({ isAddSiteModalOpen: isOpen });
      },
      setSourcesTab: (tab: string) => set({ sourcesTab: tab }),
      setPagesTab: (tab: string) => set({ pagesTab: tab }),
      setRegionsTab: (tab: string) => set({ regionsTab: tab }),
      setDevicesTab: (tab: string) => set({ devicesTab: tab }),
      setEventsTab: (tab: string) => set({ eventsTab: tab }),

    }),
    {
      name: 'analytics-http-preferences', // Unique name for this store's persistence
      storage: createJSONStorage(() => localStorage),
      partialize: (state): Partial<AnalyticsHttpState> => ({
        // Persist only user preferences and selections
        selectedSiteId: state.selectedSiteId,
        selectedRange: state.selectedRange, // Let middleware handle serialization
        sourcesTab: state.sourcesTab,
        pagesTab: state.pagesTab,
        regionsTab: state.regionsTab,
        devicesTab: state.devicesTab,
        eventsTab: state.eventsTab,
        // Do not persist: status, error, sites, userPreferences, isAddSiteModalOpen
      }),
      onRehydrateStorage: () => (state, error) => {
        console.log("HTTP Store: Rehydrating state...");
        if (error) {
          console.error("HTTP Store: Failed to rehydrate state:", error);
          return;
        }
        if (!state) {
          console.warn("HTTP Store: State is undefined during rehydration.");
          return;
        }

        // Rehydrate date range
        if (state.selectedRange?.from && state.selectedRange.to) {
          try {
            // Zustand's persist middleware might automatically handle Date objects,
            // but manual parsing provides robustness if they are stored as strings.
            const fromDate = typeof state.selectedRange.from === 'string' ? parseISO(state.selectedRange.from) : state.selectedRange.from;
            const toDate = typeof state.selectedRange.to === 'string' ? parseISO(state.selectedRange.to) : state.selectedRange.to;

            if (isValid(fromDate) && isValid(toDate)) {
              state.selectedRange = { from: fromDate, to: toDate };
              console.log("HTTP Store: Rehydrated date range:", state.selectedRange);
            } else {
              throw new Error("Invalid date string parsed during rehydration");
            }
          } catch (dateError) {
            console.error("HTTP Store: Error parsing persisted dates:", dateError);
            // Fallback to default if parsing fails
            state.selectedRange = initialHttpState.selectedRange;
          }
        } else {
          // Set default if persisted range is incomplete or missing
          state.selectedRange = initialHttpState.selectedRange;
          console.log("HTTP Store: Setting default date range during rehydration.");
        }

        // Initialize non-persisted state
        state.status = 'idle';
        state.error = null;
        state.sites = []; // Fetch fresh on load
        state.userPreferences = null; // Fetch fresh on load
        state.isAddSiteModalOpen = false; // Default to closed

        // Trigger initial site fetch *after* rehydration is complete
        // Use setTimeout to ensure rehydration finishes before fetchSites potentially updates state
        setTimeout(() => {
          const rehydratedState = useHttpStore.getState(); // Use getState() here
          console.log("HTTP Store: Post-rehydration check", { selectedSiteId: rehydratedState.selectedSiteId });
          // Fetch sites if no site ID was loaded from storage.
          // The SQL store will react once a site ID is available.
          if (!rehydratedState.selectedSiteId) {
             console.log("HTTP Store: No selected site ID rehydrated, fetching sites.");
             rehydratedState.fetchSites();
          } else {
             console.log(`HTTP Store: Rehydrated with selectedSiteId: ${rehydratedState.selectedSiteId}. SQL store should react.`);
             // Also fetch sites in the background to ensure list is up-to-date,
             // but don't necessarily change selection unless needed.
             rehydratedState.fetchSites();
          }
        }, 0);
      }
    }
  )
);