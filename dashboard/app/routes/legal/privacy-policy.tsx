import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

export default function PrivacyPolicyPage() {
  return (
    <Card className="max-w-4xl mx-auto my-8">
      <CardHeader>
        <CardTitle>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Privacy Policy</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="prose dark:prose-invert max-w-none"> {/* Using prose for basic styling */}
        <h3>IMPORTANT DISCLAIMER</h3>
        <p className="font-bold text-red-600 dark:text-red-400">
          This is a template Privacy Policy and is not legal advice. You MUST review and customize this policy with qualified legal counsel to ensure it accurately reflects your data practices and complies with all applicable laws and regulations (e.g., GDPR, CCPA). Do not use this template as-is.
        </p>

        <hr className="my-6" />

        <h2>1. Introduction</h2>
        <p>
          Welcome to TopUp Analytics ("we", "us", "our"). We are committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our website analytics service (the "Service").
        </p>

        <h2>2. Information We Collect</h2>
        <p>
          We may collect information about you in a variety of ways. The information we may collect via the Service depends on the configuration chosen by the website owner implementing our tracking script, but can include:
        </p>
        <ul>
          <li><strong>Usage Data:</strong> Information automatically collected when you visit a website using our Service, such as pages visited, time spent on pages, referring website, browser type, operating system, device type, screen dimensions, country, region, and potentially city and timezone.</li>
          <li><strong>Session Information:</strong> We use a session identifier (`session_id`) to group page views within a single browsing session. This ID does not persist across sessions by default.</li>
          <li><strong>UTM Parameters:</strong> If present in the URL, we collect standard UTM parameters (source, medium, campaign, term, content) for marketing attribution.</li>
          <li><strong>Optional Identifiers:</strong> Website owners may configure the script to collect additional identifiers like a user ID (`distinct_id`) for cross-session analysis. Collection of such identifiers may require user consent depending on applicable laws.</li>
        </ul>
        <p>
          We generally do not use cookies for tracking website visitors unless specifically configured by the website owner for purposes beyond standard analytics (which would require appropriate consent mechanisms).
        </p>

        <h2>3. How We Use Your Information</h2>
        <p>
          Having accurate information permits the website owner using our Service to:
        </p>
        <ul>
          <li>Analyze website traffic and usage patterns.</li>
          <li>Understand user engagement and improve website content.</li>
          <li>Monitor and analyze trends to improve the user experience.</li>
          <li>Attribute traffic sources for marketing purposes.</li>
        </ul>
        <p>
          We process this data on behalf of the website owner who implemented our tracking script.
        </p>

        {/* Add more standard sections like: Disclosure of Your Information, Security of Your Information, Policy for Children, Changes to This Policy, Contact Us */}
        <h2>4. Disclosure of Your Information</h2>
        <p>[Placeholder: Explain circumstances under which data might be shared, e.g., with service providers, legal requirements, business transfers. Emphasize that TopUp Analytics acts as a data processor for the website owner.]</p>

        <h2>5. Security of Your Information</h2>
        <p>[Placeholder: Describe security measures taken to protect the data collected.]</p>

        <h2>6. Data Retention</h2>
        <p>[Placeholder: Explain how long data is retained.]</p>

        <h2>7. Your Data Protection Rights</h2>
        <p>[Placeholder: Detail rights under relevant laws like GDPR/CCPA, e.g., access, rectification, erasure, objection. Explain that requests should typically be directed to the website owner (data controller).]</p>

        <h2>8. Contact Us</h2>
        <p>If you have questions or comments about this Privacy Policy, please contact the owner of the website you were visiting. If you have questions about TopUp Analytics' practices as a service provider, you can contact us at [Your Contact Email/Link].</p>

        <hr className="my-6" />
        <p className="font-bold text-red-600 dark:text-red-400">
          Reminder: This is a template. Consult with legal counsel before publishing.
        </p>
      </CardContent>
    </Card>
  );
}