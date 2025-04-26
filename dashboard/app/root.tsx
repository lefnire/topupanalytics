import {
  isRouteErrorResponse,
  Links,
  Link, // Added Link import
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import { configureAmplify } from './amplify-config';
import { AuthProvider } from './contexts/AuthContext'; // Import AuthProvider
import "./app.css";

// Configure Amplify using our dedicated function
configureAmplify();

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Basic App structure - will be enhanced with auth logic and layout later
export default function App() {
  return (
    <AuthProvider> {/* Wrap the app content with AuthProvider */}
      {/* Basic layout container - replace/enhance with shadcn later */}
      <div className="min-h-screen flex flex-col">
        {/* Header placeholder */}
        <header className="bg-gray-100 dark:bg-gray-800 p-4 shadow">
        <h1 className="text-xl font-semibold">Dashboard</h1>
      </header>
      {/* Main content area */}
      <main className="flex-grow p-4">
        <Outlet /> {/* Render the matched route's component */}
      </main>
      {/* Footer placeholder */}
      <footer className="bg-gray-100 dark:bg-gray-800 p-4 mt-8 border-t border-gray-200 dark:border-gray-700">
        <div className="container mx-auto text-center text-sm text-gray-600 dark:text-gray-400">
          <div className="flex justify-center space-x-4 mb-2">
            <Link to="/about" className="hover:underline">About</Link>
            <Link to="/docs/installation" className="hover:underline">Installation</Link>
            <Link to="/docs/cookieless-tracking" className="hover:underline">Cookieless Tracking</Link>
            <Link to="/privacy-policy" className="hover:underline">Privacy Policy</Link>
            <Link to="/terms-of-service" className="hover:underline">Terms of Service</Link>
          </div>
          <div>
            © 2025 TopUp Analytics
          </div>
        </div>
      </footer>
      </div>
    </AuthProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
