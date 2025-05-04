import { api, type Site, type UserPreferences } from '../lib/api';
import { type DateRange } from 'react-day-picker';
import { format, isToday, addDays } from 'date-fns'; // Add isToday, addDays

/**
 * Fetches the raw analytics event data for a given site and date range.
 * @param selectedSiteId The ID of the site to fetch data for.
 * @param selectedRange The date range for the data.
 * @returns A promise resolving to the fetched data.
 */
export const fetchData = async (selectedSiteId: string, selectedRange: DateRange): Promise<{
    initialEvents: any[];
    events: any[];
    commonSchema: { name: string; type: string }[];
    initialOnlySchema: { name: string; type: string }[];
}> => {
    if (!selectedSiteId) throw new Error("No site selected for fetching data.");
    if (!selectedRange?.from || !selectedRange?.to) throw new Error("Date range not selected for fetching data.");

    // Format dates for query parameters
    const startDateParam = format(selectedRange.from, 'yyyy-MM-dd');

    // Adjust end date if it's today to ensure we capture the full day's partition
    let effectiveEndDate = selectedRange.to;
    if (isToday(selectedRange.to)) {
      console.log("Adjusting end date to tomorrow for 'today' selection.");
      effectiveEndDate = addDays(selectedRange.to, 1);
    }
    const endDateParam = format(effectiveEndDate, 'yyyy-MM-dd'); // Use the potentially adjusted date

    // Construct the endpoint path with query parameters
    const endpoint = `/api/query?siteId=${selectedSiteId}&startDate=${startDateParam}&endDate=${endDateParam}`;
    console.log(`Fetching query data from endpoint: ${endpoint}`); // Log will show adjusted date if applicable

    // Use the api helper which handles base URL and auth
    const data = await api.get<any>(endpoint); // Define a proper type for the response later

    const { initialEvents, events, commonSchema, initialOnlySchema } = data;

    // Validate the structure of the received data
    if (!Array.isArray(initialEvents) || !Array.isArray(events) || !Array.isArray(commonSchema) || !Array.isArray(initialOnlySchema)) {
        throw new Error("Invalid data structure received from /api/query endpoint.");
    }

    console.log(`Received ${initialEvents.length} initial events, ${events.length} subsequent events, ${commonSchema.length} common fields, ${initialOnlySchema.length} initial-only fields.`);
    return { initialEvents, events, commonSchema, initialOnlySchema };
};

/**
 * Fetches the list of sites and user preferences.
 * @returns A promise resolving to an object containing sites and preferences.
 */
export const fetchSitesAndPreferences = async (): Promise<{ sites: Site[], preferences: UserPreferences }> => {
    console.log("Fetching sites and user preferences...");
    try {
        // Fetch sites and preferences concurrently using only the path
        console.log("Attempting api.get('/api/sites') and api.get('/api/user/preferences')..."); // Log before API calls
        const [fetchedSites, fetchedPreferences] = await Promise.all([
            api.get<Site[]>('/api/sites'),
            api.get<UserPreferences>('/api/user/preferences')
        ]);

        console.log(`Fetched ${fetchedSites.length} sites and user preferences.`);
        return { sites: fetchedSites, preferences: fetchedPreferences };
    } catch (err: any) {
        console.error("Failed to fetch sites or preferences:", err);
        // Re-throw the error to be handled by the caller (e.g., the store)
        throw new Error(err.message || 'Failed to fetch initial site/preference data.');
    }
};