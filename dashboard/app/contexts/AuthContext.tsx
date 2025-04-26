import React, { createContext, useState, useEffect, useContext } from 'react';
import type { ReactNode } from 'react'; // Type-only import for ReactNode
import { getCurrentUser, signOut as amplifySignOut, fetchAuthSession } from '@aws-amplify/auth';
import { Hub } from '@aws-amplify/core'; // Try importing Hub from core

// Define the shape of the user object (adjust as needed based on Cognito attributes)
interface AuthenticatedUser {
  userId: string;
  username: string;
  // Add other attributes you might need, e.g., email
}

// Define the context shape
export interface AuthContextType { // Export the type
  user: AuthenticatedUser | null;
  token: string | null; // Add token field
  isAuthenticated: boolean;
  isLoading: boolean;
  checkAuthStatus: () => Promise<void>; // Expose check function if needed elsewhere
  logout: () => Promise<void>;
}

// Create the context with a default value
export const AuthContext = createContext<AuthContextType | undefined>(undefined); // Export the context

// Create the AuthProvider component
interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [token, setToken] = useState<string | null>(null); // Add state for token
  const [isLoading, setIsLoading] = useState(true); // Start as loading

  const checkAuthStatus = async () => {
    setIsLoading(true);
    try {
      // Fetch session which includes tokens
      const session = await fetchAuthSession({ forceRefresh: false });
      const idToken = session.tokens?.idToken?.toString(); // Get ID token string
      const cognitoUser = await getCurrentUser(); // Still need user details

      setUser({
          userId: cognitoUser.userId,
          username: cognitoUser.username,
          // Map other attributes if needed
      });
      setToken(idToken || null); // Store the token string

    } catch (error) {
      // If fetchAuthSession or getCurrentUser throws, user is not authenticated
      setUser(null);
      setToken(null); // Clear token on error
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await amplifySignOut();
      setUser(null); // Clear user state locally
      setToken(null); // Clear token on logout
    } catch (error) {
      console.error("Error signing out: ", error);
      // Handle error appropriately, maybe show a toast
    } finally {
        setIsLoading(false);
    }
  };

  useEffect(() => {
    // Check auth status immediately on mount
    checkAuthStatus();

    // Listen for auth events (login, logout) using Hub
    // Use a more generic type for the capsule/payload if specific type isn't found
    const hubListenerCancel = Hub.listen('auth', (capsule: any) => {
      const { payload } = capsule; // Destructure payload from the capsule
      if (!payload) return; // Guard against missing payload

      switch (payload.event) {
        case 'signedIn': // Use 'signedIn' as per Amplify docs for v6+
          console.log('User signed in via Hub');
          checkAuthStatus(); // Re-check auth status after sign in
          break;
        case 'signedOut': // Use 'signedOut' as per Amplify docs for v6+
          console.log('User signed out via Hub');
          setUser(null); // Clear user state on sign out event
          setToken(null); // Clear token on sign out event
          break;
        // Add other cases if needed (e.g., tokenRefresh, autoSignIn)
      }
    });

    // Cleanup function to remove the listener
    return () => {
      hubListenerCancel();
    };
  }, []); // Empty dependency array ensures this runs only once on mount

  const value: AuthContextType = { // Ensure value matches the type
    user,
    token, // Include token in the context value
    isAuthenticated: !!user && !!token, // User is authenticated if they have a user object AND a token
    isLoading,
    checkAuthStatus,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// Custom hook to use the AuthContext
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};