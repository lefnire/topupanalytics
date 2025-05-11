/**
 * This file should handle only handle state-management and data related to HTTP
 * Any and all things analytics data (aggregation, SQL, SanKey, etc) belong to ./analyticsSqlStore.ts
 */
import { create } from "zustand";
import {persist, createJSONStorage, subscribeWithSelector} from 'zustand/middleware';
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
  selectedRangeKey: string; // Changed from selectedRange: DateRange | undefined
  isAddSiteModalOpen: boolean;

  // Card Tab States
  sourcesCardTab: string;
  pagesCardTab: string;
  eventsCardTab: string;
  regionsCardTab: string;
  devicesCardTab: string;

  // Actions
  fetchSites: () => Promise<void>;
  setSelectedSiteId: (siteId: string | null) => void;
  setSelectedRangeKey: (rangeKey: string) => void; // Renamed from setSelectedRange
  setAddSiteModalOpen: (isOpen: boolean) => void;
  resetHttpState: () => Partial<AnalyticsHttpState>; // Renamed for clarity

  // Card Tab Setters
  setSourcesCardTab: (tab: string) => void;
  setPagesCardTab: (tab: string) => void;
  setEventsCardTab: (tab: string) => void;
  setRegionsCardTab: (tab: string) => void;
  setDevicesCardTab: (tab: string) => void;

  // Getter
  getSelectedDateRangeObject: () => DateRange | undefined;
}

// Define the initial state for the HTTP store
const initialHttpState: Pick<AnalyticsHttpState,
  'status' | 'error' | 'sites' | 'selectedSiteId' | 'userPreferences' |
  'selectedRangeKey' | 'isAddSiteModalOpen' | 'sourcesCardTab' | 'pagesCardTab' | 'eventsCardTab' |
  'regionsCardTab' | 'devicesCardTab'
> = {
  status: 'idle',
  error: null,
  sites: [],
  selectedSiteId: null,
  userPreferences: null,
  selectedRangeKey: '7days', // Default to "7days"
  isAddSiteModalOpen: false,
  sourcesCardTab: 'channels', // Default tab
  pagesCardTab: 'pages', // Default tab
  eventsCardTab: 'events', // Default tab
  regionsCardTab: 'countries', // Default tab
  devicesCardTab: 'browsers', // Default tab
};

// --- Zustand Store ---
export const useHttpStore = create<AnalyticsHttpState>()(
  subscribeWithSelector(persist(
    (set, get) => ({
      ...initialHttpState,

      // --- Actions ---

      resetHttpState: () => ({
        // Reset only error, keep other state like sites, selectedId, range, tabs
        error: null,
        status: 'idle', // Reset status unless fetching
      }),

      setSelectedRangeKey: (rangeKey: string) => {
        if (rangeKey === get().selectedRangeKey) return;
        console.log("HTTP Store: Setting selected range key", rangeKey);
        set({
          selectedRangeKey: rangeKey,
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

      // --- Card Tab Setters ---
      setSourcesCardTab: (tab: string) => {
        if (tab === get().sourcesCardTab) return;
        console.log("HTTP Store: Setting sourcesCardTab", tab);
        set({ sourcesCardTab: tab });
      },
      setPagesCardTab: (tab: string) => {
        if (tab === get().pagesCardTab) return;
        console.log("HTTP Store: Setting pagesCardTab", tab);
        set({ pagesCardTab: tab });
      },
      setEventsCardTab: (tab: string) => {
        if (tab === get().eventsCardTab) return;
        console.log("HTTP Store: Setting eventsCardTab", tab);
        set({ eventsCardTab: tab });
      },
      setRegionsCardTab: (tab: string) => {
        if (tab === get().regionsCardTab) return;
        console.log("HTTP Store: Setting regionsCardTab", tab);
        set({ regionsCardTab: tab });
      },
      setDevicesCardTab: (tab: string) => {
        if (tab === get().devicesCardTab) return;
        console.log("HTTP Store: Setting devicesCardTab", tab);
        set({ devicesCardTab: tab });
      },

      // --- Getter for DateRange object ---
      getSelectedDateRangeObject: (): DateRange | undefined => {
        const key = get().selectedRangeKey;
        const now = new Date();
        const todayStart = startOfDay(now);
        const todayEnd = endOfDay(now);

        switch (key) {
          case 'today':
            return { from: todayStart, to: todayEnd };
          case 'yesterday':
            const yesterdayStart = startOfDay(subDays(now, 1));
            const yesterdayEnd = endOfDay(subDays(now, 1));
            return { from: yesterdayStart, to: yesterdayEnd };
          case '7days':
            return { from: subDays(todayStart, 6), to: todayEnd };
          case '30days':
            return { from: subDays(todayStart, 29), to: todayEnd };
          case '90days':
            return { from: subDays(todayStart, 89), to: todayEnd };
          case '6months':
            return { from: subDays(todayStart, 182), to: todayEnd }; // Approx 6 months
          case '12months':
            return { from: subDays(todayStart, 364), to: todayEnd }; // Approx 12 months
          default:
            // Attempt to parse custom range if key is like "YYYY-MM-DD_YYYY-MM-DD"
            if (typeof key === 'string' && key.includes('_')) {
              const [fromStr, toStr] = key.split('_');
              const fromDate = parseISO(fromStr);
              const toDate = parseISO(toStr);
              if (isValid(fromDate) && isValid(toDate)) {
                return { from: startOfDay(fromDate), to: endOfDay(toDate) };
              }
            }
            // Fallback to default (7 days) if key is unrecognized or custom parse fails
            console.warn(`HTTP Store: Unrecognized selectedRangeKey "${key}", defaulting to 7 days.`);
            return { from: subDays(todayStart, 6), to: todayEnd };
        }
      },
    }),
    {
      name: 'analytics-http-preferences', // Unique name for this store's persistence
      storage: createJSONStorage(() => localStorage),
      partialize: (state): Partial<AnalyticsHttpState> => ({
        // Persist only user preferences and selections
        selectedSiteId: state.selectedSiteId,
        selectedRangeKey: state.selectedRangeKey, // Persist the key
        sourcesCardTab: state.sourcesCardTab,
        pagesCardTab: state.pagesCardTab,
        eventsCardTab: state.eventsCardTab,
        regionsCardTab: state.regionsCardTab,
        devicesCardTab: state.devicesCardTab,
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

        // Rehydrate selectedRangeKey (string)
        if (typeof state.selectedRangeKey !== 'string' || !state.selectedRangeKey) {
          console.log("HTTP Store: selectedRangeKey not found or invalid in storage, setting default.");
          state.selectedRangeKey = initialHttpState.selectedRangeKey;
        } else {
          console.log("HTTP Store: Rehydrated selectedRangeKey:", state.selectedRangeKey);
        }

        // Rehydrate card tabs, falling back to defaults
        state.sourcesCardTab = typeof state.sourcesCardTab === 'string' && state.sourcesCardTab ? state.sourcesCardTab : initialHttpState.sourcesCardTab;
        state.pagesCardTab = typeof state.pagesCardTab === 'string' && state.pagesCardTab ? state.pagesCardTab : initialHttpState.pagesCardTab;
        state.eventsCardTab = typeof state.eventsCardTab === 'string' && state.eventsCardTab ? state.eventsCardTab : initialHttpState.eventsCardTab;
        state.regionsCardTab = typeof state.regionsCardTab === 'string' && state.regionsCardTab ? state.regionsCardTab : initialHttpState.regionsCardTab;
        state.devicesCardTab = typeof state.devicesCardTab === 'string' && state.devicesCardTab ? state.devicesCardTab : initialHttpState.devicesCardTab;
        console.log("HTTP Store: Rehydrated card tabs:", {
          sources: state.sourcesCardTab,
          pages: state.pagesCardTab,
          events: state.eventsCardTab,
          regions: state.regionsCardTab,
          devices: state.devicesCardTab,
        });


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
  ))
);