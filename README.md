# TopUp Analytics

A cookieless web analytics tool, focused on:
1. Privacy. Settings for GDPR / CCPA compliance, so you can avoid Cookie Consent banners (*) (basic tracking); or keep them (deeper tracking).
2. Price: $10 per 1 million events (what distinguishes this from Plausible & Matomo).

The tech is focused on serverless, scalable, cost-forward architecture so that costs can be aggressively controlled. And these savings get passed to TUA users. Alternatively, you can self-host on AWS easily, and nearly free. And unlike Plausible, whose open source repo (Community Edition) has limited features; TUA will be totally open source, always.

## (*) Cookie Consent

Cookie Consent. The debate rages on what (if anything) can be tracked without requiring Cookie Consent. Plausible, Matomo, and MixPanel claim it can be done with certain restricted tracking. TUA has 3 tiers:
1. Banner Free: aggressive pruning of cross-session and fingerprint tracking. I'm confident you can use this setting without a banner, but ask your lawyer just in case.
2. Privacy Policy: Plausible-inspired tracking, where you're likely safe without a consent banner; but you'll likely want a privacy policy and an opt-out switch. Ask your lawyer.
3. Full: tracks deeper analytics, like cross-session and fingerprinted data, so you definitely need a consent banner, and privacy policy. At this point, I'd just use Google Analytics. But I've built it in case you prefer non-Google.

More details at [blog post](https://topupanalytics/cookieless-tracking)

## Cost

Cost is the core value prop of this tool. Plausible had me at $40/m, for traffic that didn't make enough to afford that. High monthly fees is a barrier to entry for new projects. I think *all* tools should be pay-per-use, as AWS serverless tech - used heavily in this project - espouses. But especially for tools which are "valuable", rather than required, for new projects. Like analytics.

I'm committed to keeping the price $10 per million events. I'm confident I can keep my costs just below that, and I'm not interested in massive markup. I'm building this for me, and I want to share it with others. If I'm wrong on the $10 max, I'll stay true to the cost by (a) applying more aggressive architecture; and/or (b) evolving what counts as an "event". Eg currently it's "something you send to the server" (page_view, button_click, etc). But if - as I optimize performance and scale - I fail the $10 max, I'll count events more like credits towards more expensive operations. Eg 1 event per database write; 1 event per operation in a dashboard report.

Current estimated per-million events cost to me, all steps considered: `$1.74` (needs re-evaluation after migration)

---

## Data Pipeline: Aurora/Drizzle & Hybrid Query Architecture

This pipeline is designed for cost-effectiveness, scalability, and near real-time data availability, leveraging Aurora Serverless v2 (Postgres) with Drizzle ORM, an HTTP Firehose for ingestion, and a hybrid query approach.

## Architecture Overview

1.  **Ingest:** Client -> Router (CloudFront) -> `ingestFn` (Lambda) -> `IngestHttpFirehose` (HTTP Destination) -> `processIngestFn` (Lambda in VPC)
    *   Client sends events to the Router (`/api/event`).
    *   Router forwards to the lightweight `ingestFn`.
    *   `ingestFn` performs minimal validation and forwards the payload to the `IngestHttpFirehose`.
    *   The Firehose buffers events and sends batches via its HTTP Destination to the `processIngestFn`.

2.  **Processing (`processIngestFn`):**
    *   Receives batches from the HTTP Firehose.
    *   Decodes and decompresses event data.
    *   Fetches and caches site configuration (e.g., allowance, settings) from Aurora using Drizzle ORM.
    *   Validates events against site settings, filters out invalid/blocked events, and enriches data.
    *   Performs bulk inserts of valid events into Aurora `events` and `initial_events` tables using Drizzle.
    *   Forwards valid, processed events to the *original* S3/Iceberg Firehoses (`eventsStream`, `initialEventsStream`) for long-term storage.
    *   Updates the site's event allowance usage in the Aurora `sites` table.

3.  **Long-Term Storage & Archival:** `eventsStream`/`initialEventsStream` (Firehose) -> S3 (Parquet) -> Glue Catalog (Iceberg Tables)
    *   The original Firehose streams (`eventsStream`, `initialEventsStream`) receive processed events from `processIngestFn`.
    *   Buffering settings for these streams are increased to optimize S3 writes and reduce costs.
    *   Firehose converts data to Parquet and writes to S3, partitioned by `site_id` and `dt`.
    *   Glue Data Catalog with Iceberg tables (`eventsTable`, `initialEventsTable`) provides the schema and metadata for querying archived data via Athena.

4.  **Query (`queryFn`):** Dashboard -> API Gateway (`ManagementApi`) -> `queryFn` (Lambda in VPC) -> Aurora (Drizzle) / Athena
    *   Dashboard calls the authenticated `/api/query` endpoint.
    *   `queryFn` (running in the VPC) performs an ownership check against the `sites` table in Aurora (via Drizzle).
    *   Based on the query's time range:
        *   **Recent Data (e.g., <= 30 days):** Queries the `events` / `initial_events` tables directly in Aurora using Drizzle for fast results.
        *   **Older Data (> 30 days):** Queries the historical data in the S3 data lake via Athena using the Glue Iceberg tables.

5.  **Database Schema & Migrations:**
    *   Transactional data (e.g., `accounts`, `sites`, `preferences`) and recent analytics data (`events`, `initial_events`) are stored in Aurora Postgres.
    *   The database schema is managed using Drizzle ORM (`shared/db/schema.ts`).
    *   Schema migrations are handled by Drizzle Kit and applied via the `DbMigrationFn` Lambda function.

6.  **Maintenance:**
    *   Aurora Serverless v2 handles scaling automatically.
    *   Iceberg's automatic compaction handles S3 data optimization for the archived data. Periodic manual `OPTIMIZE` via Athena is generally not required.

---

## Future Plans
Later I'll add more "pay per use" alternatives to common website tools. Next would be comments with auto moderation, like Disqus ($20/m). Then webpage upvotes / downvotes and discoverability.