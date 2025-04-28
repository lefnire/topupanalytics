// Core tracking logic for Topup Analytics

// Define window interface for TypeScript
interface TopupWindow extends Window {
  topup?: {
    event: (eventName: string, eventData?: Record<string, any>) => void;
  };
}
// Correct declaration merging for window
declare global {
    interface Window {
        topup?: {
            event: (eventName: string, eventData?: Record<string, any>) => void;
        };
    }
}

const INGEST_URL = import.meta.env.VITE_PUBLIC_INGEST_URL;

if (!INGEST_URL) {
  console.error("Topup Analytics: Ingest URL is not configured.");
}

// --- Initialization & API ---
(function() {
  const script = document.currentScript as HTMLScriptElement | null;

  if (!script) {
    console.error("Topup Analytics: Could not find the executing script tag. Initialization failed.");
    return; // Exit if script tag cannot be found
  }

  const siteId = script.dataset.site;
  const level = script.dataset.level || 'basic'; // Default level if not provided

  if (!siteId) {
    console.error("Topup Analytics: 'data-site' attribute is missing on the script tag. Initialization failed.");
    return;
  }

  // --- Notrack Logic ---
  let TRACK = true; // Default to tracking enabled
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const notrackParam = searchParams.get('notrack');
    const notrackStorage = localStorage.getItem("notrack");

    if (notrackParam !== null || notrackStorage === "true") {
      TRACK = false;
      if (notrackParam !== null) {
        localStorage.setItem("notrack", "true");
        // Optional: Clean the URL parameter
        // searchParams.delete('notrack');
        // history.replaceState(null, '', `${window.location.pathname}?${searchParams.toString()}${window.location.hash}`);
      }
      console.log("Topup Analytics: Tracking disabled ('notrack' found).");
    }
  } catch (e) {
    console.error("Topup Analytics: Error processing 'notrack' logic:", e);
    // Decide if tracking should be disabled on error, default is to continue if possible
  }

  if (!TRACK) {
    // If tracking is disabled globally, don't proceed further with initialization logic
    // but still define a dummy API so calls don't break websites.
    window.topup = { event: () => {} };
    console.log(`Topup Analytics: Initialized (tracking disabled) for site ${siteId}`);
    return;
  }

  console.log(`Topup Analytics: Initializing for site ${siteId} (level: ${level})`);

  // --- Session Management & Initial Event ---
  let sessionId: string | null = null;
  let is_initial_event = false;
  try {
    sessionId = sessionStorage.getItem('session_id');
    if (!sessionId) {
      is_initial_event = true;
      sessionId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      sessionStorage.setItem("session_id", sessionId);
      console.log("Topup Analytics: New session started:", sessionId);
    } else {
      console.log("Topup Analytics: Existing session found:", sessionId);
    }
  } catch (e) {
    console.error("Topup Analytics: Error accessing sessionStorage:", e);
    // Fallback: Generate a session ID for this page load only if sessionStorage fails
    sessionId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    is_initial_event = true; // Treat as initial if storage fails
    console.log("Topup Analytics: Using temporary session ID due to storage error:", sessionId);
  }

  // --- UTM Parameter Handling (only on initial event) ---
  const utmParams: Record<string, string> = {};
  if (is_initial_event) {
    try {
      const searchParams = new URLSearchParams(window.location.search);
      let utmDeleted = false;
      for (const k of ['utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term']) {
        const val = searchParams.get(k);
        if (val) {
          utmParams[k] = val;
          // Optional: Clean the URL parameters
          // searchParams.delete(k);
          // utmDeleted = true;
        }
      }
      // if (utmDeleted) {
      //   history.replaceState(null, '', `${window.location.pathname}?${searchParams.toString()}${window.location.hash}`);
      // }
    } catch (e) {
      console.error("Topup Analytics: Error processing UTM parameters:", e);
    }
  }

  // --- Send Event Function ---
  function sendEvent(eventName: string, eventData?: Record<string, any>) {
    if (!TRACK || !INGEST_URL || !siteId || !sessionId) return;

    const commonPayload: Record<string, any> = {
      site_id: siteId,
      event: eventName,
      pathname: window.location.pathname,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      properties: eventData || {}, // Use provided eventData as properties
    };

    let finalPayload: Record<string, any>;

    if (is_initial_event) {
      finalPayload = {
        ...commonPayload,
        is_initial_event: true,
        screen_height: window.screen.height,
        screen_width: window.screen.width,
        referer: document.referrer || '$direct', // Send $direct if empty
        language: navigator.language, // Keep language for now
        ...utmParams, // Add captured UTM parameters
      };
      // After the first event is sent, subsequent events in this session are not initial
      is_initial_event = false;
    } else {
      finalPayload = commonPayload;
    }

    // Construct the target URL with the siteId query parameter
    const targetUrl = `${INGEST_URL}?site=${encodeURIComponent(siteId)}`;

    // Use fetch
    try {
      fetch(targetUrl, {
        method: 'POST',
        body: JSON.stringify(finalPayload),
        // Removed headers: { 'Content-Type': 'application/json' }
        keepalive: true, // Attempt to keep request alive on page unload
      }).catch(error => console.error('Topup Analytics: Error sending event via fetch:', error));
      // console.log("Topup Analytics: Event sent via fetch:", finalPayload);
    } catch (e) {
        console.error('Topup Analytics: Error sending event:', e);
    }
  }

  // --- Public API ---
  const topupApi = {
    event: (eventName: string, eventData?: Record<string, any>) => {
      if (!siteId) {
        console.error("Topup Analytics: Cannot send event, Site ID is missing.");
        return;
      }
      if (!TRACK) {
        // console.log("Topup Analytics: Tracking disabled, event skipped:", eventName);
        return;
      }
      sendEvent(eventName, eventData);
    }
  };

  // Expose the API on window.topup
  if (window.topup) {
    console.warn("Topup Analytics: window.topup already exists. Overwriting.");
  }
  window.topup = topupApi;

  // Automatically track page view after initialization
  // This will now correctly use the session ID and initial event logic
  window.topup.event('pageview');

})(); // Immediately invoke the function

export {}; // Add this line to treat the file as a module