// --- Configuration ---
const INGEST_URL = import.meta.env.VITE_PUBLIC_INGEST_URL;
const SESSION_ID_KEY = "_topup_sid";
const NOTRACK_KEY = "_topup_notrack";
const INITIAL_EVENT_SENT_KEY = "_topup_initial_sent";

// --- Schema (Copied from functions/analytics/schema.ts for simplicity) ---
type Safe = "yes" | "maybe" | "no";

interface SchemaField {
  name: string;
  type: string;
  description: string;
  safe: Safe;
}

const commonSchema: SchemaField[] = [
  { name: "event",           type: "string",             description: "Event key (e.g. 'page_view').",                         safe: "yes" },
  { name: "pathname",        type: "string",             description: "location.pathname.",                                   safe: "yes" },
  { name: "session_id",      type: "string",             description: "Ephemeral ID stored in sessionStorage or memory only.",safe: "yes" },
  // timestamp is added server-side
  { name: "properties",      type: "map<string,string>", description: "Arbitrary event props (MUST exclude PII).",            safe: "maybe" },
];

const initialOnlySchema: SchemaField[] = [
  /* HIGH-RISK */
  { name: "distinct_id",     type: "string", description: "Cross-session user ID.",                        safe: "no" },
  { name: "model",           type: "string", description: "Device model.",                                 safe: "no" },
  { name: "manufacturer",    type: "string", description: "Device OEM.",                                   safe: "no" },
  /* MEDIUM-RISK */
  { name: "city",            type: "string", description: "Viewer city (≈25 k pop. granularity).",         safe: "maybe" },
  { name: "timezone",        type: "string", description: "IANA TZ (e.g. America/Denver).",               safe: "maybe" },
  { name: "browser_version", type: "string", description: "Full browser version string.",                 safe: "maybe" },
  { name: "os_version",      type: "string", description: "Full OS version.",                             safe: "maybe" },
  { name: "screen_height",   type: "string", description: "window.screen.height.",                        safe: "maybe" },
  { name: "screen_width",    type: "string", description: "window.screen.width.",                         safe: "maybe" },
  /* LOW-RISK */
  { name: "region",          type: "string", description: "State/region code.",                           safe: "yes" },
  { name: "country",         type: "string", description: "ISO-3166 country.",                            safe: "yes" },
  { name: "device",          type: "string", description: "Device class (mobile / desktop / tablet).",    safe: "yes" },
  { name: "browser",         type: "string", description: "Browser family (Chrome, Safari …).",           safe: "yes" },
  { name: "os",              type: "string", description: "OS family (Windows, iOS …).",                  safe: "yes" },
  { name: "referer",         type: "string", description: "Full Referer (scrub querystring!).",           safe: "yes" },
  { name: "referer_domain",  type: "string", description: "eTLD+1 of referer.",                           safe: "yes" },
  { name: "utm_source",      type: "string", description: "UTM source.",                                  safe: "yes" },
  { name: "utm_campaign",    type: "string", description: "UTM campaign.",                                safe: "yes" },
  { name: "utm_medium",      type: "string", description: "UTM medium.",                                  safe: "yes" },
  { name: "utm_content",     type: "string", description: "UTM content.",                                 safe: "yes" },
  { name: "utm_term",        type: "string", description: "UTM term.",                                    safe: "yes" },
];

const combinedSchema = [...commonSchema, ...initialOnlySchema];

// --- State ---
interface TopupConfig {
  siteId: string | null;
  level: 'basic' | 'enhanced' | 'full';
  sessionId: string;
  isTrackingDisabled: boolean;
  isInitialEvent: boolean;
}

let config: TopupConfig | null = null;
let lastTrackedPath: string | null = null;

// --- Utilities ---
function generateUUID(): string {
  // Basic UUID v4 generation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getSessionId(): string {
  try {
    let sid = sessionStorage.getItem(SESSION_ID_KEY);
    if (!sid) {
      sid = generateUUID();
      sessionStorage.setItem(SESSION_ID_KEY, sid);
    }
    return sid;
  } catch (e) {
    // sessionStorage might be disabled
    return generateUUID(); // Use in-memory for this session
  }
}

function isTrackingDisabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('notrack') === 'true') {
      localStorage.setItem(NOTRACK_KEY, 'true');
      return true;
    }
    return localStorage.getItem(NOTRACK_KEY) === 'true';
  } catch (e) {
    return false; // Assume tracking enabled if localStorage fails
  }
}

function isInitialEventSent(): boolean {
    try {
        return sessionStorage.getItem(INITIAL_EVENT_SENT_KEY) === 'true';
    } catch (e) {
        return false; // Assume not sent if sessionStorage fails
    }
}

function markInitialEventSent(): void {
    try {
        sessionStorage.setItem(INITIAL_EVENT_SENT_KEY, 'true');
        if (config) config.isInitialEvent = false; // Update in-memory state
    } catch (e) {
        // Ignore if sessionStorage fails
    }
}

function getConfigFromScriptTag(): { siteId: string | null; level: 'basic' | 'enhanced' | 'full' } {
  const script = document.currentScript as HTMLScriptElement | null;
  const siteId = script?.getAttribute('data-site') || null;
  const levelAttr = script?.getAttribute('data-level') || 'enhanced';
  const level = ['basic', 'enhanced', 'full'].includes(levelAttr)
    ? levelAttr as 'basic' | 'enhanced' | 'full'
    : 'enhanced'; // Default to enhanced if invalid
  return { siteId, level };
}

function cleanReferrer(referrer: string): string {
    if (!referrer) return '';
    try {
        const url = new URL(referrer);
        // Keep origin and pathname, strip query and hash
        return url.origin + url.pathname;
    } catch (e) {
        return ''; // Invalid URL
    }
}

function getReferrerDomain(referrer: string): string {
    if (!referrer) return '';
    try {
        const url = new URL(referrer);
        // Basic domain extraction (doesn't handle eTLD+1 perfectly but is simple)
        return url.hostname;
    } catch (e) {
        return '';
    }
}

// Basic User Agent Parsing (Consider a library for more accuracy if needed)
function getBrowserInfo(ua: string): { browser: string; os: string; device: string; browser_version?: string; os_version?: string } {
    // Very basic parsing - improvements needed for robustness
    let browser = 'Unknown', os = 'Unknown', device = 'desktop', browser_version, os_version;

    // OS
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/Android/i.test(ua)) { os = 'Android'; device = 'mobile'; }
    else if (/iPhone|iPad|iPod/i.test(ua)) { os = 'iOS'; device = /iPhone|iPod/i.test(ua) ? 'mobile' : 'tablet'; }

    // Browser
    if (/Chrome|CriOS/i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome|CriOS/i.test(ua)) browser = 'Safari';
    else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
    else if (/MSIE|Trident/i.test(ua)) browser = 'IE';
    else if (/Edg/i.test(ua)) browser = 'Edge';

    // Basic Version Extraction (Example for Chrome)
    const chromeMatch = ua.match(/Chrome\/([0-9.]+)/i);
    if (chromeMatch) browser_version = chromeMatch[1];
    // Add similar logic for other browsers/OS if needed

    return { browser, os, device, browser_version, os_version };
}

function getUTMParams(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  let hasUtm = false;

  utmKeys.forEach(key => {
    if (params.has(key)) {
      utm[key] = params.get(key)!;
      hasUtm = true;
    }
  });

  // Remove UTM params from URL if present
  if (hasUtm) {
    utmKeys.forEach(key => params.delete(key));
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    try {
      window.history.replaceState(window.history.state, '', newUrl);
    } catch (e) {
      console.error("Topup: Could not replace history state.", e);
    }
  }

  return utm;
}

// --- Data Collection ---
function collectInitialData(): Record<string, any> {
  const uaInfo = getBrowserInfo(navigator.userAgent);
  const screen = window.screen;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const referrer = cleanReferrer(document.referrer);

  return {
    // High risk ('no') - require 'full' level
    // distinct_id: '', // Requires cross-session logic, not implemented here
    // model: '', // Requires more advanced fingerprinting
    // manufacturer: '', // Requires more advanced fingerprinting

    // Medium risk ('maybe') - require 'enhanced' or 'full' level
    city: '', // Requires GeoIP lookup (server-side or external service)
    timezone: tz,
    browser_version: uaInfo.browser_version,
    os_version: uaInfo.os_version,
    screen_height: screen?.height?.toString(),
    screen_width: screen?.width?.toString(),

    // Low risk ('yes') - included in 'basic'
    region: '', // Requires GeoIP lookup
    country: '', // Requires GeoIP lookup
    device: uaInfo.device,
    browser: uaInfo.browser,
    os: uaInfo.os,
    referer: referrer,
    referer_domain: getReferrerDomain(referrer),
    ...getUTMParams(), // UTMs are 'yes'
  };
}

// --- Data Filtering ---
function filterDataByLevel(data: Record<string, any>, level: 'basic' | 'enhanced' | 'full'): Record<string, any> {
  const allowedSafeness: Safe[] = level === 'basic' ? ['yes']
                               : level === 'enhanced' ? ['yes', 'maybe']
                               : ['yes', 'maybe', 'no']; // 'full' allows all

  const filtered: Record<string, any> = {};
  for (const field of combinedSchema) {
    if (data.hasOwnProperty(field.name) && allowedSafeness.includes(field.safe)) {
      // Special handling for properties map
      if (field.name === 'properties' && typeof data.properties === 'object' && data.properties !== null) {
         // Only include properties if level is 'enhanced' or 'full' (as properties itself is 'maybe')
         if (level === 'enhanced' || level === 'full') {
            filtered.properties = data.properties;
         }
      } else if (data[field.name] !== undefined && data[field.name] !== null && data[field.name] !== '') {
         // Only include non-empty values
         filtered[field.name] = data[field.name];
      }
    }
  }
  return filtered;
}


// --- Event Sending ---
function sendEvent(payload: Record<string, any>): void {
  if (!config || config.isTrackingDisabled || !config.siteId) {
    console.log("Topup: Tracking disabled or not configured.", payload);
    return;
  }

  // Check if INGEST_URL is defined
  if (!INGEST_URL) {
      console.error("Topup: Ingest URL is not configured. Cannot send event.");
      return;
  }

  const finalPayload = {
    ...payload,
    site_id: config.siteId, // Add site_id here
    is_initial_event: config.isInitialEvent, // Add flag
  };

  const blob = new Blob([JSON.stringify(finalPayload)], { type: 'application/json' });

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(INGEST_URL, blob);
    } else {
      fetch(INGEST_URL, {
        method: 'POST',
        body: blob,
        keepalive: true, // Important for fetch fallback
        headers: { 'Content-Type': 'application/json' }
      });
    }
    console.log("Topup: Event sent", finalPayload);

    // Mark initial event as sent *after* successful sending attempt
    if (config.isInitialEvent) {
        markInitialEventSent();
    }

  } catch (error) {
    console.error("Topup: Error sending event:", error);
  }
}

// --- Core Tracking Function ---
function track(eventName: string, properties: Record<string, string> = {}): void {
  if (!config || config.isTrackingDisabled) return;

  const commonData = {
    event: eventName,
    pathname: window.location.pathname,
    session_id: config.sessionId,
    properties: properties && Object.keys(properties).length > 0 ? properties : undefined, // Only include if non-empty
  };

  let eventData = { ...commonData };

  if (config.isInitialEvent) {
    const initialData = collectInitialData();
    eventData = { ...initialData, ...commonData }; // Common data overrides initial if keys clash (e.g., properties)
  }

  const filteredData = filterDataByLevel(eventData, config.level);
  sendEvent(filteredData);
}


// --- Automatic Event Listeners ---

// Page View Tracking
function trackPageView(): void {
    if (!config || config.isTrackingDisabled) return;

    const currentPath = window.location.pathname + window.location.search; // Include search for uniqueness
    if (currentPath === lastTrackedPath) {
        // Avoid double tracking the exact same path immediately after SPA navigation
        return;
    }
    lastTrackedPath = currentPath; // Update last tracked path

    // Use a minimal timeout to allow SPA routers to potentially update title/state
    setTimeout(() => {
        track('page_view');
    }, 50);
}


// Click Tracking
function handleClick(event: MouseEvent): void {
  if (!config || config.isTrackingDisabled) return;

  let target = event.target as HTMLElement | null;
  while (target && target !== document.body) {
    const eventName = target.getAttribute('data-topup-event');
    if (eventName) {
      const properties: Record<string, string> = {};
      for (let i = 0; i < target.attributes.length; i++) {
        const attr = target.attributes[i];
        if (attr.name.startsWith('data-topup-property-')) {
          const key = attr.name.substring('data-topup-property-'.length);
          properties[key] = attr.value;
        }
      }
      track(eventName, properties);
      break; // Stop searching up the DOM tree once an event is found
    }
    target = target.parentElement;
  }
}

// SPA Navigation Tracking
function setupSpaTracking(): void {
    // Track initial page view
    trackPageView();

    // Track changes via history API
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        originalPushState.apply(this, args);
        trackPageView(); // Track after state change
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
        originalReplaceState.apply(this, args);
        // Usually don't track replaceState unless it significantly changes context,
        // but UTM removal uses it, so we need to be careful not to track that.
        // trackPageView(); // Decide if replaceState should trigger page views
    };

    // Track back/forward navigation
    window.addEventListener('popstate', trackPageView);
}


// --- Initialization ---
export function init(levelOverride?: 'basic' | 'enhanced' | 'full'): void {
  if (typeof window === 'undefined' || !document) return; // Guard for non-browser environments

  // Prevent double initialization
  if (config) {
      console.warn("Topup: Already initialized.");
      return;
  }

  const scriptConfig = getConfigFromScriptTag();
  const finalLevel = levelOverride || scriptConfig.level; // Allow specific files to override

  config = {
    siteId: scriptConfig.siteId,
    level: finalLevel,
    sessionId: getSessionId(),
    isTrackingDisabled: isTrackingDisabled(),
    isInitialEvent: !isInitialEventSent(), // Check if initial event was already sent this session
  };

  if (config.isTrackingDisabled) {
    console.log("Topup: Tracking is disabled via notrack parameter or localStorage.");
    return;
  }

  if (!config.siteId) {
    console.error("Topup: data-site attribute is missing or invalid.");
    return; // Don't proceed without siteId
  }

  console.log(`Topup: Initializing level '${config.level}' for site '${config.siteId}' (Initial: ${config.isInitialEvent})`);

  // Setup global function
  (window as any).topup = {
    event: track,
  };

  // Add event listeners
  document.body.addEventListener('click', handleClick, true); // Use capture phase

  // Setup SPA page view tracking (includes initial page view)
  // Wait for DOM ready before setting up listeners and tracking initial view
  if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupSpaTracking);
  } else {
      setupSpaTracking();
  }
}

// Expose track globally if needed (though init should set window.topup.event)
// export { track }; // Optional: if direct import access is desired elsewhere