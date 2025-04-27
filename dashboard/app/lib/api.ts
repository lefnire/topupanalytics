import { useContext, useCallback } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { fetchAuthSession } from 'aws-amplify/auth'; // Import fetchAuthSession

const API_BASE_URL = import.meta.env.VITE_API_URL;

interface RequestOptions extends RequestInit {
  token?: string | null;
  isJson?: boolean;
}

async function fetchWithAuth(
  endpoint: string,
  options: RequestOptions = {}
): Promise<Response> {
  const { token, isJson = true, ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (isJson && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }


  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...fetchOptions,
    headers,
  });

  if (!response.ok) {
    // Attempt to parse error details from the response body
    let errorData;
    try {
      errorData = await response.json();
    } catch (e) {
      // Ignore if response body is not JSON or empty
    }
    console.error('API Error:', response.status, response.statusText, errorData);
    // Throw a more informative error object
    throw new Error(`API request failed: ${response.status} ${response.statusText}${errorData?.message ? ` - ${errorData.message}` : ''}`);
  }

  return response;
}

// Hook to provide API functions with automatic token injection
export function useApiClient() {
  const auth = useContext(AuthContext);

  if (!auth) {
    throw new Error("useApiClient must be used within an AuthProvider");
  }

  const { token } = auth;

  // Memoize the core request function
  const request = useCallback(async <T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: any
  ): Promise<T> => {
    const options: RequestOptions = {
      method,
      token, // token dependency here
    };

    if (data) {
        if (options.method !== 'GET') {
             options.body = JSON.stringify(data);
             options.isJson = true;
        } else {
            // Handle query parameters for GET requests if needed
            console.warn("Data provided for GET request, ignoring:", data);
        }
    }

    const response = await fetchWithAuth(endpoint, options);

    // Handle cases where the response might be empty (e.g., 204 No Content)
    if (response.status === 204) {
        return undefined as T; // Or handle as appropriate for your application
    }

    // Handle text response for script endpoint
    if (endpoint.endsWith('/script')) {
        return await response.text() as T;
    }

    return await response.json() as T;
  }, [token]); // Dependency: re-create if token changes

  // Memoize the returned API methods
  const get = useCallback(<T = any>(endpoint: string) => request<T>('GET', endpoint), [request]);
  const post = useCallback(<T = any>(endpoint: string, data: any) => request<T>('POST', endpoint, data), [request]);
  const put = useCallback(<T = any>(endpoint: string, data: any) => request<T>('PUT', endpoint, data), [request]);
  const del = useCallback(<T = any>(endpoint: string) => request<T>('DELETE', endpoint), [request]);

  return { get, post, put, del };
}

// --- Standalone API Client for non-component usage (e.g., Zustand stores) ---

// Re-usable function to get the token
const getAuthToken = async (): Promise<string | null> => {
 try {
   console.log("Standalone API: Attempting to fetch auth session...");
   const session = await fetchAuthSession();
   console.log("Standalone API: Auth session fetched:", session);
   const idToken = session.tokens?.idToken?.toString();
   console.log("Standalone API: Extracted ID Token:", idToken);
   return idToken || null;
 } catch (error) {
   console.error("Standalone API: Failed to get auth token during fetchAuthSession", error);
   return null;
 }
};

// Standalone request function
const standaloneRequest = async <T = any>(
 method: 'GET' | 'POST' | 'PUT' | 'DELETE',
 endpoint: string,
 data?: any
): Promise<T> => {
 const token = await getAuthToken();
 console.log(`Standalone API: Token for ${method} ${endpoint}:`, token); // Log the token being used
  // Basic error handling if token fetch fails, might need more robust handling
  if (!token && !endpoint.includes('/public/')) { // Allow public endpoints if needed
      console.error(`Standalone API: No token available for protected endpoint ${endpoint}`);
      throw new Error("Authentication token not available for standalone request.");
 }

 const options: RequestOptions = {
   method,
   token, // Pass token to fetchWithAuth
 };

 if (data) {
   if (method !== 'GET') {
     options.body = JSON.stringify(data);
     options.isJson = true;
   } else {
     // Handle query params for GET if necessary, or ignore data
     console.warn("Standalone API: Data provided for GET request, ignoring:", data);
   }
 }

 const response = await fetchWithAuth(endpoint, options); // fetchWithAuth handles base URL and headers

 if (response.status === 204) {
   return undefined as T;
 }

 // Handle text response specifically if needed (like the script endpoint)
 if (endpoint.endsWith('/script')) {
     return await response.text() as T;
 }

 // Default to JSON parsing
 return await response.json() as T;
};

// Exported standalone functions
export const api = {
 get: <T = any>(endpoint: string) => standaloneRequest<T>('GET', endpoint),
 post: <T = any>(endpoint: string, data: any) => standaloneRequest<T>('POST', endpoint, data),
 put: <T = any>(endpoint: string, data: any) => standaloneRequest<T>('PUT', endpoint, data),
 del: <T = any>(endpoint: string) => standaloneRequest<T>('DELETE', endpoint),
};


// Define Site type based on backend schema (adjust as needed)
export interface Site {
    site_id: string;
    user_id: string;
    name: string;
    allowed_domains: string; // JSON string array
    allowed_fields: string; // JSON string array
    is_active: boolean;
    created_at: string;
    updated_at: string;
    request_allowance: number; // Added
    plan: string; // Added (e.g., 'free', 'paid')
}

// Define UserPreferences type based on backend schema
export interface UserPreferences {
    user_id: string;
    is_payment_active: boolean;
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null; // May not be needed for pay-as-you-go
    stripe_last4?: string | null;
    created_at: string;
    updated_at: string;
}