// Common schema for both initial events and regular events
interface SchemaField {
    name: string;
    type: string;
    compliant: boolean;
}

export const commonSchema: SchemaField[] = [
  {name: "event", type: "string", compliant: true},
  {name: "pathname", type: "string", compliant: true},
  {name: "session_id", type: "string", compliant: true},
  {name: "timestamp", type: "timestamp", compliant: true}, // Assuming event has its own timestamp
  {name: "properties", type: "map<string,string>", compliant: true}, // Example for custom properties
]

// Additional fields that are only needed for initial events
export const initialOnlySchema: SchemaField[] = [ // Export this schema
  // single-session tracking in compliant-mode; cross-session otherwise
  {name: "distinct_id", type: "string", compliant: false},
  {name: "city", type: "string", compliant: false},
  {name: "region", type: "string", compliant: true},
  {name: "country", type: "string", compliant: true},
  {name: "timezone", type: "string", compliant: false},
  {name: "device", type: "string", compliant: true},
  {name: "browser", type: "string", compliant: true},
  {name: "browser_version", type: "string", compliant: false},
  {name: "os", type: "string", compliant: true},
  {name: "os_version", type: "string", compliant: false},
  {name: "model", type: "string", compliant: false},
  {name: "manufacturer", type: "string", compliant: false},
  {name: "referer", type: "string", compliant: true},
  {name: "referer_domain", type: "string", compliant: true},
  {name: "screen_height", type: "string", compliant: true},
  {name: "screen_width", type: "string", compliant: true},
  {name: "utm_source", type: "string", compliant: true},
  {name: "utm_campaign", type: "string", compliant: true},
  {name: "utm_medium", type: "string", compliant: true},
  {name: "utm_content", type: "string", compliant: true},
  {name: "utm_term", type: "string", compliant: true},
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
