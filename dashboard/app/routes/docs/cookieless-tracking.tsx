import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

// Simple CodeBlock component placeholder
const CodeBlock = ({ children }: { children: React.ReactNode }) => (
  <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-md overflow-x-auto my-4">
    <code className="text-sm font-mono">{children}</code>
  </pre>
);

// Helper to render lists of fields
const FieldList = ({ fields }: { fields: string[] }) => (
  <ul className="list-disc list-inside my-2 space-y-1">
    {fields.map(field => <li key={field}><code>{field}</code></li>)}
  </ul>
);

// Schema fields based on prompt
const commonCompliant = ['event', 'pathname', 'session_id', 'timestamp', 'properties'];
const initialCompliant = ['region', 'country', 'device', 'browser', 'os', 'referer', 'referer_domain', 'screen_height', 'screen_width', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term'];
const initialNonCompliant = ['distinct_id', 'city', 'timezone', 'browser_version', 'os_version', 'model', 'manufacturer'];

// Categorize for Tiers
const tier1Fields = [...commonCompliant, ...initialCompliant];
const tier2Fields = ['timezone']; // Example low-risk non-compliant
const tier3Fields = ['city', 'browser_version', 'os_version', 'model', 'manufacturer']; // Higher-risk non-compliant
const tier4Fields = ['distinct_id']; // Cross-session ID

export default function CookielessTrackingPage() {
  return (
    <Card className="max-w-4xl mx-auto my-8">
      <CardHeader>
        <CardTitle>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Understanding Cookieless Tracking & Compliance</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="prose dark:prose-invert max-w-none">

        <h3>Introduction</h3>
        <p>
          TopUp Analytics primarily uses cookieless tracking methods. This approach focuses on event-based data collection during a single browsing session, minimizing the persistent tracking of users across different visits, which is common with traditional cookie-based analytics. The primary benefit is enhanced user privacy and easier compliance with regulations like GDPR and CCPA, as less potentially identifying information is stored long-term on the user's device.
        </p>

        <h3>How It Works</h3>
        <p>
          Instead of placing cookies, our script collects data points for each relevant event (like a page view) that occurs during a user's visit. Key aspects include:
        </p>
        <ul>
          <li><strong>Event Data:</strong> Captures details about the action, like the page visited (<code>pathname</code>) and custom properties.</li>
          <li><strong>Sessionization:</strong> Events within the same browsing session are linked using a temporary <code>session_id</code>. This ID typically expires when the browser tab is closed or after a period of inactivity, and does not persist across separate visits by default.</li>
          <li><strong>Fingerprinting Potential:</strong> While avoiding cookies, collecting certain browser and device details (like browser version, OS version, screen size, installed fonts, etc.) can contribute to "fingerprinting" – creating a unique identifier based on device characteristics. TopUp Analytics aims to minimize highly unique data points by default, but the specific fields collected impact the level of fingerprinting potential.</li>
        </ul>

        <h3>Data Fields & Compliance Considerations</h3>
        <p>
          The tracking script can collect various fields. Some are collected with every event ("Common"), while others are typically captured only on the first event of a session ("Initial Only"). We've categorized fields based on their potential compliance implications under typical privacy regulations (like GDPR). Fields marked <code>compliant: true</code> are generally considered less sensitive and less likely to require explicit user consent <em>on their own</em>, while <code>compliant: false</code> fields carry a higher potential for identifying individuals and warrant more careful consideration.
        </p>
        <p>
          Below is a breakdown based on the default schema, categorized into tiers reflecting potential compliance risk and recommended actions. <strong>Remember, you control which fields are collected via the 'Allowed Fields' setting for your site.</strong>
        </p>

        <hr className="my-6" />

        <h4>Tier 1: Likely Safe without Consent Banner (<code>compliant: true</code> fields)</h4>
        <p>These fields provide essential session-level analytics with minimal privacy risk. They generally don't require a consent banner under GDPR/ePrivacy when used for legitimate interest purposes like basic website analytics, but a clear mention in your Privacy Policy is essential.</p>
        <strong>Fields Included:</strong>
        <FieldList fields={tier1Fields} />
        <strong>Recommendation:</strong> Ensure your Privacy Policy clearly lists these fields and explains their use for website analytics. Consent banner typically not required <em>for these fields alone</em>.

        <hr className="my-4" />

        <h4>Tier 2: Likely Safe without Consent Banner, Privacy Policy Recommended (Low-risk <code>compliant: false</code>)</h4>
        <p>These fields add slightly more detail but are generally considered low risk in terms of uniquely identifying users on their own. They might slightly increase fingerprinting potential but are often justifiable under legitimate interest.</p>
        <strong>Fields Included:</strong>
        <FieldList fields={tier2Fields} />
        <strong>Recommendation:</strong> Clearly document these in your Privacy Policy. Consent banner likely not required, but risk is slightly elevated compared to Tier 1. Assess necessity.

        <hr className="my-4" />

        <h4>Tier 3: Consult Lawyer, Privacy Policy Essential (Higher-risk <code>compliant: false</code>)</h4>
        <p>These fields provide more granular geographic or technical details. Combining several of these significantly increases the potential for fingerprinting and identifying a user or device. While consent <em>might</em> not be strictly required if the data is handled carefully (e.g., aggregated, not used for profiling individuals), the risk is substantially higher.</p>
        <strong>Fields Included:</strong>
        <FieldList fields={tier3Fields} />
        <strong>Recommendation:</strong> <strong>Strongly advise consulting with a qualified legal professional</strong> familiar with privacy regulations in your target regions. A comprehensive Privacy Policy is mandatory. Carefully evaluate if the benefit outweighs the compliance risk and burden. Consider if aggregation or pseudonymization techniques can be applied.

        <hr className="my-4" />

        <h4>Tier 4: Consent Banner Recommended (<code>compliant: false</code>, Cross-Session ID)</h4>
        <p>This tier includes fields specifically designed to identify and track users across multiple sessions, similar to how traditional analytics cookies function. Collecting this type of identifier almost certainly requires explicit, informed user consent under regulations like GDPR and CCPA before tracking begins.</p>
        <strong>Fields Included:</strong>
        <FieldList fields={tier4Fields} />
        <strong>Recommendation:</strong> <strong>Implement a compliant consent banner/mechanism</strong> to obtain user permission <em>before</em> collecting this field. Clearly explain its purpose in your Privacy Policy. If you require robust cross-session user identification, consider if TopUp Analytics' cookieless approach is the right fit, or if tools explicitly designed for consented tracking (like Google Analytics with consent mode) might be more appropriate.

        <hr className="my-6" />

        <h3>Disclaimer</h3>
        <p className="font-bold text-orange-600 dark:text-orange-400">
          This guide provides general information and compliance considerations based on common interpretations of privacy laws like GDPR. It is NOT legal advice. You are solely responsible for ensuring your use of TopUp Analytics complies with all applicable laws and regulations in your jurisdiction and the jurisdictions of your users. Data privacy laws are complex and evolve. We strongly recommend consulting with qualified legal counsel to determine the appropriate compliance strategy for your specific situation and data collection practices.
        </p>

        <h3>Configuration</h3>
        <p>
          Remember that you have control over which data fields are collected. In your Site Settings within the TopUp Analytics dashboard, you can configure the <code>allowed_fields</code> list to include only the data points you need and are comfortable collecting from a compliance perspective. By default, we aim for a privacy-preserving set, but reviewing and adjusting this list according to your legal assessment is crucial.
        </p>

      </CardContent>
    </Card>
  );
}