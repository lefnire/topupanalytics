/*
Here’s a **bold-but-defensible** three-tier split plus an updated schema that replaces the old `compliant: boolean` with a clearer risk flag:

### Why each tier shakes out this way

| Tier | Core idea | Typical legal hook |
|------|-----------|--------------------|
| **yes** | Either _pure content_ (page path, UTM) or coarse context that can’t single out a person even when combined (device class, country). No identifier is stored on the user’s device, so ePrivacy “cookie” rules don’t bite. | GDPR **Recital 26** anonymisation; ePrivacy Art. 5 only governs storage/access in the terminal equipment. |
| **maybe** | Adds granularity that _could_ single somebody out (city, screen size, full UA strings) **or** accepts arbitrary props. This is still widely treated as “legitimate interest analytics” → privacy policy + opt-out. | GDPR **Art. 6(1)(f)** balancing test; CNIL & EDPB guidance on audience-measurement cookies. |
| **no** | Cross-session IDs or high-entropy fingerprint bits (device model/OEM) create a persistent online identifier → prior consent required. | GDPR **Art. 4(1)** definition of “personal data”; ePrivacy Art. 5 consent for non-essential identifiers. |

---

### Fingerprinting & cross-session uniques without consent?

* **Daily-rotating, salted hash** of `(truncated IP + UA)` à la Plausible _can_ stay in “maybe” if you:
  1. Drop the salt every 24 h (breaks re-identification).
  2. Truncate IP to /24 for IPv4 or /48 for IPv6 before hashing.
  3. Never export the raw hash; use it only for server-side unique-visit math.

* **Session continuity**: use `sessionStorage` or in-memory var → nothing persists after tab close, so it remains tier 1.

* **Custom properties**: whitelist keys and run a regex to nuke emails, phone numbers, UUID-looking strings. Anything user-provided is a liability.

---

### Implementation tips

1. **Config switch** – expose a single `complianceLevel: "basic" | "enhanced" | "full"` option in your installer.
2. **User-facing doc string** – auto-generate a snippet for the client’s privacy policy when they pick level 2, listing the concrete fields.
3. **Banner helper** – for level 3 return a ready-made CMP JSON so devs can drop it into Cookiebot / Klaro.
4. **Geo accuracy** – stick to `country`+`region`; `city` bumps the risk score mainly because of UK ICO & German DSK opinions.
5. **Referer hygiene** – strip querystring & fragment (`new URL(r).origin + URL.pathname`) before storing; you dodge inadvertent PII in links.

Run with this split and you’ll match (or overshoot) Plausible’s legal posture while still offering richer, opt-in metrics when your customers want them.

 */

// “yes”   = no banner, no privacy policy needed
// “maybe” = publish a privacy policy + opt-out, banner still not required
// “no”    = full cookie / consent banner needed (GDPR Art. 6(1)(a), ePrivacy Art. 5)
type Safe = "yes" | "maybe" | "no";

export interface SchemaField {
  name: string;
  type: string;
  description: string;
  safe: Safe;
}

/* ────────────────── ALWAYS-SAFE CORE (no banner, no policy) ────────────────── */
export const commonSchema: SchemaField[] = [
  { name: "event",           type: "string",             description: "Event key (e.g. 'page_view').",                         safe: "yes" },
  { name: "pathname",        type: "string",             description: "location.pathname.",                                   safe: "yes" },
  { name: "session_id",      type: "string",             description: "Ephemeral ID stored in sessionStorage or memory only.",safe: "yes" },
  { name: "timestamp",       type: "timestamp",          description: "Server-receive timestamp (ISO).",                      safe: "yes" },
  { name: "properties",      type: "map<string,string>", description: "Arbitrary event props (MUST exclude PII).",            safe: "maybe" },
];

/* ────────────────── FIELDS SENT ONLY WITH FIRST EVENT IN A VISIT ───────────── */
export const initialOnlySchema: SchemaField[] = [
  /* HIGH-RISK  → banner a must */
  { name: "distinct_id",     type: "string", description: "Cross-session user ID.",                        safe: "no" },
  { name: "model",           type: "string", description: "Device model.",                                 safe: "no" },
  { name: "manufacturer",    type: "string", description: "Device OEM.",                                   safe: "no" },

  /* MEDIUM-RISK → publish a privacy policy & opt-out switch */
  { name: "city",            type: "string", description: "Viewer city (≈25 k pop. granularity).",         safe: "maybe" },
  { name: "timezone",        type: "string", description: "IANA TZ (e.g. America/Denver).",               safe: "maybe" },
  { name: "browser_version", type: "string", description: "Full browser version string.",                 safe: "maybe" },
  { name: "os_version",      type: "string", description: "Full OS version.",                             safe: "maybe" },
  { name: "screen_height",   type: "string", description: "window.screen.height.",                        safe: "maybe" },
  { name: "screen_width",    type: "string", description: "window.screen.width.",                         safe: "maybe" },

  /* LOW-RISK → still banner-free */
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
