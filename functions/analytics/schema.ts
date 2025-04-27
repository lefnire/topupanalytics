// Common schema for both initial events and regular events
interface SchemaField {
    name: string;
    type: string;
    description?: string;
    compliant: boolean;
}

export const commonSchema: SchemaField[] = [
  {name: "event", type: "string", description: "Event key. 'page_view' for Page Views, whatever you want for anything else", compliant: true},
  {name: "pathname", type: "string", description: "Pathname of the page visited, from client-side location.pathname", compliant: true},
  {name: "session_id", type: "string", description: "ID unique to the user's session, generated client-side. Use sessionStorage, or an in-memory variable for SPAs. For compliant mode, only track events within a single session, not across sessions.", compliant: true},
  {name: "timestamp", type: "timestamp", description: "Timestamp when the event was received by the server", compliant: true},
  {name: "properties", type: "map<string,string>", description: "Custom key-value properties sent with the event from the client", compliant: true},
]

// Additional fields that are only needed for initial events
export const initialOnlySchema: SchemaField[] = [ // Export this schema
  // single-session tracking in compliant-mode; cross-session otherwise
  {name: "distinct_id", type: "string", description: "ID unique to the user, generated client-side (used for cross-session tracking if not compliant)", compliant: false},
  {name: "city", type: "string", description: "User's city, derived from CloudFront headers (cloudfront-viewer-city)", compliant: false},
  {name: "region", type: "string", description: "User's region/state name or code, derived from CloudFront headers (cloudfront-viewer-country-region-name/code)", compliant: true},
  {name: "country", type: "string", description: "User's country name, derived from CloudFront headers (cloudfront-viewer-country-name)", compliant: true},
  {name: "timezone", type: "string", description: "User's timezone, derived from CloudFront headers (cloudfront-viewer-time-zone)", compliant: false},
  {name: "device", type: "string", description: "Device type (e.g., mobile, tablet, desktop) or vendor/model, parsed from User-Agent header", compliant: true},
  {name: "browser", type: "string", description: "Browser name, parsed from User-Agent header", compliant: true},
  {name: "browser_version", type: "string", description: "Browser version, parsed from User-Agent header", compliant: false},
  {name: "os", type: "string", description: "Operating system name, parsed from User-Agent header", compliant: true},
  {name: "os_version", type: "string", description: "Operating system version, parsed from User-Agent header", compliant: false},
  {name: "model", type: "string", description: "Device model, parsed from User-Agent header", compliant: false},
  {name: "manufacturer", type: "string", description: "Device manufacturer/vendor, parsed from User-Agent header", compliant: false},
  {name: "referer", type: "string", description: "Referring URL, captured client-side or from HTTP header. '$direct' if same-origin or no referer.", compliant: true},
  {name: "referer_domain", type: "string", description: "Domain of the referring URL, derived from referer. '$direct' if same-origin or no referer.", compliant: true},
  {name: "screen_height", type: "string", description: "Screen height in pixels, from client-side window.screen.height", compliant: true},
  {name: "screen_width", type: "string", description: "Screen width in pixels, from client-side window.screen.width", compliant: true},
  {name: "utm_source", type: "string", description: "UTM source parameter from the URL, captured client-side", compliant: true},
  {name: "utm_campaign", type: "string", description: "UTM campaign parameter from the URL, captured client-side", compliant: true},
  {name: "utm_medium", type: "string", description: "UTM medium parameter from the URL, captured client-side", compliant: true},
  {name: "utm_content", type: "string", description: "UTM content parameter from the URL, captured client-side", compliant: true},
  {name: "utm_term", type: "string", description: "UTM term parameter from the URL, captured client-side", compliant: true},
]

// Complete schema for initial events (includes all fields)
export const initialEventsSchema: SchemaField[] = [...commonSchema, ...initialOnlySchema] // Export this schema

// Schema for regular events (only includes common fields)
const eventsSchema: SchemaField[] = commonSchema

// Export schemas for both tables
export const initialGlueColumns = initialEventsSchema.map(s => ({
  name: s.name,
  type: s.type
}))

export const eventsGlueColumns = eventsSchema.map(s => ({
  name: s.name,
  type: s.type
}))

// For backward compatibility
export const glueColumns = initialEventsSchema.map(s => ({
  name: s.name,
  type: s.type
}))

// Create compliance maps for both schemas
export const isInitialCompliant = Object.fromEntries(initialEventsSchema.map(s => [s.name, s.compliant]))
export const isEventsCompliant = Object.fromEntries(eventsSchema.map(s => [s.name, s.compliant]))
export const isCompliant = isInitialCompliant

// Create column lists for both schemas
export const initialColsCompliant = initialEventsSchema.filter(s => s.compliant).map(s => s.name)
export const eventsColsCompliant = eventsSchema.filter(s => s.compliant).map(s => s.name)
export const initialColsAll = initialEventsSchema.map(s => s.name)
export const eventsColsAll = eventsSchema.map(s => s.name)

// For backward compatibility
export const colsCompliant = initialColsCompliant
export const colsAll = initialColsAll

// TODO this will be per-account checkbox when the webapp is setup
export const ONLY_COMPLIANT = true;
