import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

export default function TermsOfServicePage() {
  return (
    <Card className="max-w-4xl mx-auto my-8">
      <CardHeader>
        <CardTitle>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Terms of Service</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="prose dark:prose-invert max-w-none"> {/* Using prose for basic styling */}
        <h3>IMPORTANT DISCLAIMER</h3>
        <p className="font-bold text-red-600 dark:text-red-400">
          This is a template Terms of Service and is not legal advice. You MUST review and customize these terms with qualified legal counsel to ensure they accurately reflect your service offerings, business practices, and comply with all applicable laws. Do not use this template as-is.
        </p>

        <hr className="my-6" />

        <h2>1. Agreement to Terms</h2>
        <p>
          By accessing or using the TopUp Analytics service ("Service"), provided by [Your Company Name] ("we", "us", "our"), you agree to be bound by these Terms of Service ("Terms"). If you disagree with any part of the terms, then you may not access the Service.
        </p>

        <h2>2. Description of Service</h2>
        <p>
          TopUp Analytics provides a web analytics platform designed to offer insights into website traffic and user behavior, often utilizing cookieless tracking methods. Features and capabilities are subject to change.
        </p>

        <h2>3. User Accounts</h2>
        <p>
          [Placeholder: Detail requirements for account creation, user responsibilities for account security, accuracy of information, etc.]
        </p>

        <h2>4. Use of the Service</h2>
        <p>
          You agree to use the Service in compliance with all applicable laws and regulations and these Terms. You are responsible for:
        </p>
        <ul>
          <li>Ensuring you have the necessary rights and consents to collect data from your website visitors using our Service.</li>
          <li>Implementing the tracking script correctly on your website(s).</li>
          <li>Complying with privacy laws (e.g., GDPR, CCPA) regarding notice, consent, and data subject rights for the data you collect via the Service.</li>
          <li>Not using the Service for any illegal or unauthorized purpose.</li>
          <li>[Placeholder: Add specific prohibited uses if necessary, e.g., tracking sensitive data without appropriate measures, reverse engineering the service.]</li>
        </ul>

        <h2>5. Fees and Payment</h2>
        <p>
          [Placeholder: Describe your pricing model, payment terms, subscription details, renewal policies, refund policy (if any).]
        </p>

        <h2>6. Intellectual Property</h2>
        <p>
          The Service and its original content, features, and functionality are and will remain the exclusive property of [Your Company Name] and its licensors.
        </p>

        <h2>7. Data Privacy</h2>
        <p>
          Our collection and use of personal information in connection with the Service are described in our Privacy Policy. By using the Service, you agree to the terms of the Privacy Policy. You, as the website owner, are the data controller for the visitor data collected via the Service on your website; we act as the data processor.
        </p>

        <h2>8. Disclaimers</h2>
        <p>
          The Service is provided on an "AS IS" and "AS AVAILABLE" basis. We make no warranties, expressed or implied, regarding the operation or availability of the Service, or the information, content, or materials included therein. [Placeholder: Add specific disclaimers, e.g., regarding accuracy of data, uptime guarantees (or lack thereof).]
        </p>

        <h2>9. Limitation of Liability</h2>
        <p>
          [Placeholder: Include limitations on your liability arising from the use of the Service, subject to applicable law.]
        </p>

        <h2>10. Indemnification</h2>
        <p>
          [Placeholder: Require users to indemnify you against claims arising from their misuse of the Service or violation of these Terms.]
        </p>

        <h2>11. Termination</h2>
        <p>
          [Placeholder: Describe conditions under which you or the user can terminate the agreement/account.]
        </p>

        <h2>12. Governing Law</h2>
        <p>
          [Placeholder: Specify the governing law and jurisdiction for disputes.]
        </p>

        <h2>13. Changes to Terms</h2>
        <p>
          We reserve the right, at our sole discretion, to modify or replace these Terms at any time. [Placeholder: Explain how changes will be communicated and when they become effective.]
        </p>

        <h2>14. Contact Us</h2>
        <p>
          If you have any questions about these Terms, please contact us at [Your Contact Email/Link].
        </p>

        <hr className="my-6" />
        <p className="font-bold text-red-600 dark:text-red-400">
          Reminder: This is a template. Consult with legal counsel before publishing.
        </p>
      </CardContent>
    </Card>
  );
}