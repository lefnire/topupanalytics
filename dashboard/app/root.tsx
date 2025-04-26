import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { Amplify } from 'aws-amplify';
import { Authenticator, ThemeProvider, defaultTheme } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css'; // Default Amplify UI styles

import type { Route } from "./+types/root";
import "./app.css";

// Configure Amplify
Amplify.configure({
  Auth: {
    Cognito: {
      region: import.meta.env.VITE_AWS_REGION, // Reverted to prompt structure
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
    }
  }
});

// Optional: Customize Amplify UI theme if needed
const theme = {
  name: 'custom-theme',
  tokens: {
    // Add custom theme tokens here if desired
  },
};

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

// Wrap the main App component with Authenticator
export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <Authenticator>
        {({ signOut, user }) => (
          <main>
            {/* Optional: Display user info or sign out button */}
            {/* <h1>Hello {user?.username}</h1> */}
            {/* <button onClick={signOut}>Sign out</button> */}
            <Outlet /> {/* Render the rest of the app */}
          </main>
        )}
      </Authenticator>
    </ThemeProvider>
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
