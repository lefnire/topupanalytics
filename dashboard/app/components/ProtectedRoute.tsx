import React from 'react';
import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  children?: React.ReactNode; // Allow wrapping specific children if needed later
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    // Optional: Show a loading spinner or skeleton screen while checking auth
    return (
        <div className="flex items-center justify-center min-h-screen">
            Loading...
        </div>
    );
  }

  if (!isAuthenticated) {
    // Redirect to login page if not authenticated
    return <Navigate to="/login" replace />;
  }

  // If authenticated, render the child components (or Outlet if no children passed)
  return children ? <>{children}</> : <Outlet />;
};

export default ProtectedRoute;