import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

// Simple CodeBlock component placeholder
const CodeBlock = ({ children }: { children: React.ReactNode }) => (
  <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-md overflow-x-auto my-4">
    <code className="text-sm">{children}</code>
  </pre>
);

export default function InstallationDocsPage() {
  return (
    <Card className="max-w-3xl mx-auto my-8">
      <CardHeader>
        <CardTitle>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Installation Guide</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4">
          Follow these steps to install the TopUp Analytics tracking script on your website:
        </p>
        <ol className="list-decimal list-inside space-y-2 mb-6">
          <li>
            Log in to your TopUp Analytics dashboard.
          </li>
          <li>
            Navigate to the site you want to track. If you haven't added your site yet, create one first.
          </li>
          <li>
            Go to the <strong>Site Settings</strong> page for your chosen site (usually accessible via a gear icon or settings link on the site detail page, e.g., <code>/sites/YOUR_SITE_ID</code>).
          </li>
          <li>
            Find the section labeled <strong>"Embed Script"</strong> or similar. You should see a component displaying the script.
          </li>
          <li>
            Copy the entire script tag provided in that section. It will look something like this (your actual domain and Site ID will be filled in):
          </li>
        </ol>

        <CodeBlock>
{`<script
  async
  defer
  src="https://your-tracker-domain.com/tracker.js"
  data-site-id="YOUR_SITE_ID"
></script>`}
        </CodeBlock>

        <p className="mt-4 mb-2">
          <strong>Note:</strong> The <code>YOUR_SITE_ID</code> and the script <code>src</code> URL will be specific to your account and site configuration. Use the exact script provided in your dashboard.
        </p>

        <ol start={6} className="list-decimal list-inside space-y-2">
          <li>
            Open the HTML code of your website.
          </li>
          <li>
            Paste the copied script tag just before the closing <code>&lt;/head&gt;</code> tag in your HTML document(s). For Single Page Applications (SPAs), ensure this runs on the initial page load.
          </li>
          <li>
            Save the changes to your HTML file and deploy them to your web server.
          </li>
        </ol>

        <p className="mt-6">
          That's it! Once the script is correctly installed and your site is visited, TopUp Analytics will begin tracking. Data should start appearing in your dashboard within a few minutes.
        </p>
&lt;hr className="my-8" /&gt;

        &lt;h3 className="text-xl font-semibold leading-none tracking-tight mt-8 mb-4"&gt;Manual Integration (Advanced)&lt;/h3&gt;
        &lt;p className="mb-4"&gt;
          If you prefer not to use the standard embed script or need more control over data collection, you can integrate TopUp Analytics manually by sending events directly to our ingest endpoint using the &lt;code&gt;fetch&lt;/code&gt; API.
        &lt;/p&gt;
        &lt;p className="mb-4"&gt;
          The public ingest URL for your account is available via the environment variable: &lt;code&gt;{import.meta.env.VITE_PUBLIC_INGEST_URL || 'https://{your-router-url}/api/event'}&lt;/code&gt;.
        &lt;/p&gt;
        &lt;p className="mb-4"&gt;
          &lt;strong&gt;Important:&lt;/strong&gt; When integrating manually, you are responsible for generating session IDs, collecting relevant data (like screen size, referer, UTM parameters), and filtering data according to your chosen compliance level and privacy requirements.
        &lt;/p&gt;

        &lt;h4 className="text-lg font-semibold leading-none tracking-tight mt-6 mb-2"&gt;1. Generating a Session ID&lt;/h4&gt;
        &lt;p className="mb-4"&gt;
          You need a unique identifier for each user session. A simple approach is to use &lt;code&gt;sessionStorage&lt;/code&gt; and generate a unique ID if one doesn't exist.
        &lt;/p&gt;
        &lt;CodeBlock&gt;
{`function getSessionId() {
  let sessionId = sessionStorage.getItem('topup_session_id');
  if (!sessionId) {
    // Generate a simple unique ID (consider a more robust UUID library for production)
    sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2);
    sessionStorage.setItem('topup_session_id', sessionId);
  }
  return sessionId;
}

const currentSessionId = getSessionId();`}
        &lt;/CodeBlock&gt;

        &lt;h4 className="text-lg font-semibold leading-none tracking-tight mt-6 mb-2"&gt;2. Sending a Page View Event&lt;/h4&gt;
        &lt;p className="mb-4"&gt;
          To track page views, send a POST request to the ingest URL with the event type set to &lt;code&gt;page_view&lt;/code&gt;.
        &lt;/p&gt;
        &lt;p className="mb-4"&gt;
          The first event sent for a given &lt;code&gt;session_id&lt;/code&gt; should ideally include initial session data like screen dimensions, referrer, and UTM parameters. You can track this by checking if the session ID was just generated or by using another flag in &lt;code&gt;sessionStorage&lt;/code&gt;.
        &lt;/p&gt;
        &lt;CodeBlock&gt;
{`async function trackPageView(siteId, ingestUrl) {
  const sessionId = getSessionId(); // Use the function from step 1
  const isInitialEvent = !sessionStorage.getItem('topup_initial_event_sent'); // Example check

  const payload = {
    site_id: siteId,
    session_id: sessionId,
    event: 'page_view',
    pathname: window.location.pathname,
    hostname: window.location.hostname,
    // Add more fields as needed, especially for the initial event
  };

  if (isInitialEvent) {
    payload.screen_width = window.screen.width;
    payload.screen_height = window.screen.height;
    payload.referer = document.referrer;
    // Add logic here to parse window.location.search for UTM parameters (utm_source, etc.)
    // payload.utm_source = ...;
    sessionStorage.setItem('topup_initial_event_sent', 'true'); // Mark initial event as sent
  }

  try {
    const response = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true, // Important for requests sent during page unload
    });
    if (!response.ok) {
      console.error('TopUp Analytics: Failed to send page_view event', response.statusText);
    }
  } catch (error) {
    console.error('TopUp Analytics: Error sending page_view event', error);
  }
}

// Example usage:
// const YOUR_SITE_ID = 'your-actual-site-id'; // Replace with your Site ID
// const INGEST_URL = '${import.meta.env.VITE_PUBLIC_INGEST_URL || 'https://{your-router-url}/api/event'}';
// trackPageView(YOUR_SITE_ID, INGEST_URL);`}
        &lt;/CodeBlock&gt;

        &lt;h4 className="text-lg font-semibold leading-none tracking-tight mt-6 mb-2"&gt;3. Sending a Custom Event&lt;/h4&gt;
        &lt;p className="mb-4"&gt;
          To track custom events (e.g., button clicks, form submissions), send a POST request with your desired event name and include any relevant custom data in the &lt;code&gt;properties&lt;/code&gt; object.
        &lt;/p&gt;
        &lt;CodeBlock&gt;
{`async function trackCustomEvent(siteId, ingestUrl, eventName, properties = {}) {
  const sessionId = getSessionId(); // Use the function from step 1

  const payload = {
    site_id: siteId,
    session_id: sessionId,
    event: eventName,
    pathname: window.location.pathname,
    hostname: window.location.hostname,
    properties: properties, // Add your custom data here
  };

  try {
    const response = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!response.ok) {
      console.error(\`TopUp Analytics: Failed to send \${eventName} event\`, response.statusText);
    }
  } catch (error) {
    console.error(\`TopUp Analytics: Error sending \${eventName} event\`, error);
  }
}

// Example usage:
// const YOUR_SITE_ID = 'your-actual-site-id'; // Replace with your Site ID
// const INGEST_URL = '${import.meta.env.VITE_PUBLIC_INGEST_URL || 'https://{your-router-url}/api/event'}';
// trackCustomEvent(YOUR_SITE_ID, INGEST_URL, 'signup_button_click', { plan: 'free' });`}
        &lt;/CodeBlock&gt;
      </CardContent>
    </Card>
  );
}