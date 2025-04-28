// Core tracking logic for Topup Analytics
// Core tracking logic for Topup Analytics

// Define window interface for TypeScript
interface TopupWindow extends Window {
  topup?: {
    event: (eventName: string, eventData?: Record<string, any>) => void;
  };
}
declare let window: TopupWindow;

const INGEST_URL = import.meta.env.VITE_PUBLIC_INGEST_URL;

if (!INGEST_URL) {
  console.error("Topup Analytics: Ingest URL is not configured.");
}

function sendEvent(eventName: string, siteId: string, eventData?: Record<string, any>) {
  if (!INGEST_URL || !siteId) return; // Also check for siteId here

  const payload = {
    siteId: siteId,
    event: eventName,
    data: eventData || {},
    timestamp: new Date().toISOString(),
    url: window.location.href,
    referrer: document.referrer,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    language: navigator.language,
  };

  // Construct the target URL with the siteId query parameter
  const targetUrl = `${INGEST_URL}?site=${encodeURIComponent(siteId)}`;

  // Use sendBeacon if available, otherwise fallback to fetch
  if (navigator.sendBeacon) {
    navigator.sendBeacon(targetUrl, JSON.stringify(payload));
  } else {
    fetch(targetUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      keepalive: true, // Attempt to keep request alive on page unload
    }).catch(error => console.error('Topup Analytics: Error sending event:', error));
  }
}

// --- Initialization & API ---
(function() {
  const script = document.currentScript as HTMLScriptElement | null;

  if (!script) {
    console.error("Topup Analytics: Could not find the executing script tag. Initialization failed.");
    // Fallback attempt (less reliable)
    // const scripts = document.querySelectorAll('script[src*="/topup-"]');
    // script = scripts[scripts.length - 1] as HTMLScriptElement | null;
    // if (!script) {
    //   console.error("Topup Analytics: Fallback script tag search also failed.");
    //   return;
    // }
    return; // Exit if script tag cannot be found
  }

  const siteId = script.dataset.site;
  const level = script.dataset.level || 'basic'; // Default level if not provided

  if (!siteId) {
    console.error("Topup Analytics: 'data-site' attribute is missing on the script tag. Initialization failed.");
    return;
  }

  console.log(`Topup Analytics: Initializing for site ${siteId} (level: ${level})`);

  // Define the public API
  const topupApi = {
    event: (eventName: string, eventData?: Record<string, any>) => {
      if (!siteId) {
        // This should theoretically not happen due to the check above, but good for safety
        console.error("Topup Analytics: Cannot send event, Site ID is missing.");
        return;
      }
      sendEvent(eventName, siteId, eventData);
    }
  };

  // Expose the API on window.topup
  if (window.topup) {
    console.warn("Topup Analytics: window.topup already exists. Overwriting.");
  }
  window.topup = topupApi;

  // Automatically track page view after initialization
  window.topup.event('pageview');

})(); // Immediately invoke the function