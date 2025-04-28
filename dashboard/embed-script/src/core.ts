// Core tracking logic for Topup Analytics
interface TopupAnalyticsAPI {
  track: (eventName: string, eventData?: Record<string, any>) => void;
  init: (siteId: string) => void;
  _q?: Array<['track' | 'init', ...any[]]>;
  _siteId?: string;
}

// Use a more unique name to avoid potential conflicts
interface TopupWindow extends Window {
  _topupAnalytics?: TopupAnalyticsAPI;
}

declare let window: TopupWindow;

const INGEST_URL = import.meta.env.VITE_PUBLIC_INGEST_URL;

if (!INGEST_URL) {
  console.error("Topup Analytics: Ingest URL is not configured.");
}

function sendEvent(eventName: string, siteId: string, eventData?: Record<string, any>) {
  if (!INGEST_URL) return;

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

  // Use sendBeacon if available, otherwise fallback to fetch
  if (navigator.sendBeacon) {
    navigator.sendBeacon(INGEST_URL, JSON.stringify(payload));
  } else {
    fetch(INGEST_URL, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      keepalive: true, // Attempt to keep request alive on page unload
    }).catch(error => console.error('Topup Analytics: Error sending event:', error));
  }
}

// --- Public API ---
const topupApi: TopupAnalyticsAPI = {
  track: (eventName: string, eventData?: Record<string, any>) => {
    const analytics = window._topupAnalytics;
    if (!analytics?._siteId) {
      console.warn("Topup Analytics: 'init' must be called before 'track'. Queuing event.");
      // Ensure the analytics object and its queue exist before pushing
      if (!window._topupAnalytics) {
        window._topupAnalytics = { ...topupApi, _q: [] }; // Initialize if totally missing
      } else if (!window._topupAnalytics._q) {
        window._topupAnalytics._q = [];
      }
      // Assign to a const after checks to help TS narrow the type
      const currentAnalytics = window._topupAnalytics;
      // We know currentAnalytics and currentAnalytics._q are defined here
      currentAnalytics._q!.push(['track', eventName, eventData]); // Use non-null assertion for certainty
      return;
    }
    // If we reach here, analytics (now currentAnalytics) and _siteId must be defined
    sendEvent(eventName, analytics._siteId, eventData);
  },
  init: (siteId: string) => {
    if (!siteId) {
      console.error("Topup Analytics: Site ID is required for initialization.");
      return;
    }
    // Ensure the object exists
    if (!window._topupAnalytics) {
        window._topupAnalytics = { ...topupApi }; // Initialize with API methods
    }

    const analytics = window._topupAnalytics;

    if (analytics._siteId) {
        console.warn(`Topup Analytics: Already initialized with site ID ${analytics._siteId}. Ignoring new init call.`);
        return;
    }
    analytics._siteId = siteId;
    console.log(`Topup Analytics: Initialized for site ${siteId}`);

    // Process any queued events
    const queue = analytics._q;
    if (queue) {
      queue.forEach(args => {
        const [command, ...params] = args;
        if (command === 'track') {
          // Call track directly now that siteId is set
          topupApi.track(params[0] as string, params[1] as Record<string, any>);
        }
        // Add other commands here if needed
      });
      delete analytics._q; // Clear queue after processing
    }

    // Automatically track page view on init
    topupApi.track('pageview');
  }
};

// --- Initialization ---
// Expose the API and handle pre-existing queue
const existingQueue = window._topupAnalytics?._q || [];
// Ensure the global object exists and merge API methods, preserving queue
window._topupAnalytics = {
    ...topupApi, // Add API methods
    ...window._topupAnalytics, // Preserve existing properties like _siteId if already init'd somehow
    _q: existingQueue // Ensure queue is preserved or initialized
};


// Process queue if init was called before script loaded
const initCall = existingQueue.find(args => args[0] === 'init');
if (initCall && !window._topupAnalytics._siteId) { // Check if not already initialized
    window._topupAnalytics.init(initCall[1] as string);
}

// Exporting for potential module usage, though these scripts are IIFE
// For IIFE, this export isn't strictly necessary but doesn't hurt
export { topupApi };