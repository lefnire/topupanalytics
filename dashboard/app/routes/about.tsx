import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export default function AboutPage() {
  return (
    <Card className="max-w-3xl mx-auto my-8">
      <CardHeader>
        <CardTitle>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">About TopUp Analytics</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          TopUp Analytics is a privacy-focused, cost-effective web analytics platform designed to give you valuable insights into your website's performance without compromising user privacy.
        </p>
        <p className="mt-4">
          We believe in transparent data collection and providing tools that help you understand your audience while respecting their digital footprint. Our cookieless tracking approach minimizes data collection to essential metrics, helping you stay compliant with evolving privacy regulations.
        </p>
      </CardContent>
    </Card>
  );
}