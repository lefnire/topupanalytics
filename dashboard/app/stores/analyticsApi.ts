import { api, type Site, type UserPreferences } from '~/lib/api';
import { type DateRange } from 'react-day-picker';
import { format, isToday, addDays } from 'date-fns'; // Add isToday, addDays

/**
 * Fetches the raw analytics event data for a given site and date range.
 * The API returns data as value arrays and schemas, which are reconstructed here.
 * @param selectedSiteId The ID of the site to fetch data for.
 * @param selectedRange The date range for the data.
 * @returns A promise resolving to the fetched and reconstructed data.
 */

// Type for the raw API response (values arrays + schemas)
type AnalyticsApiResponse = {
   initialEventsValues: any[][];
   eventsValues: any[][];
   commonSchema: { name: string; type: string }[];
   initialOnlySchema: { name: string; type: string }[];
};

// Return type of fetchData (reconstructed objects + schemas)
type FetchDataResult = {
   initialEvents: Record<string, any>[];
   events: Record<string, any>[];
   commonSchema: { name: string; type: string }[];
   initialOnlySchema: { name: string; type: string }[];
};


export const fetchData = async (selectedSiteId: string, selectedRange: DateRange): Promise<FetchDataResult> => {
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
    const data = await api.get<AnalyticsApiResponse>(endpoint); // Use the defined API response type

    const { initialEventsValues, eventsValues, commonSchema, initialOnlySchema } = data;

    // Validate the structure of the received data
    if (!Array.isArray(initialEventsValues) || !Array.isArray(eventsValues) || !Array.isArray(commonSchema) || !Array.isArray(initialOnlySchema)) {
        throw new Error("Invalid data structure received from /api/query endpoint.");
    }

    // Helper function to reconstruct objects from schema and value arrays
    const reconstructObjects = (schema: { name: string }[], values: any[][]): Record<string, any>[] => {
        if (!values || values.length === 0 || !schema || schema.length === 0) {
            return [];
        }
        const headers = schema.map(s => s.name);
        return values.map(row => {
            const eventObject: Record<string, any> = {};
            headers.forEach((header, index) => {
                // Ensure row has enough elements, default to null if not
                eventObject[header] = index < row.length ? row[index] : null;
            });
            return eventObject;
        });
    };

    // Reconstruct the event objects
    const initialEventSchema = [...commonSchema, ...initialOnlySchema]; // Combine schemas for initial events
    const initialEvents = reconstructObjects(initialEventSchema, initialEventsValues);
    const events = reconstructObjects(commonSchema, eventsValues); // Use only commonSchema for subsequent events

    console.log(`Received ${initialEventsValues.length} initial event value arrays, ${eventsValues.length} subsequent event value arrays.`);
    console.log(`Reconstructed ${initialEvents.length} initial events, ${events.length} subsequent events.`);

    // Return the reconstructed objects and schemas
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