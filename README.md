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

Current estimated per-million events cost to me, all steps considered: `$1.74` (keep this updated)

---

## Data Pipeline: Cost-Optimized & Scalable Analytics (S3/Glue/Firehose/Iceberg)

The primary goal of this data pipeline is extreme cost-effectiveness and scalability, aiming to support a high volume of events and queries affordably. It uses a standard AWS serverless data lake architecture.

## Architecture Overview

1.  **Ingest:** Client -> Router (CloudFront) -> Lambda (`ingestFn`) -> Firehose (JSON)
    *   Events hit the public Router endpoint (`/api/event`).
    *   Router forwards to `ingestFn` Lambda.
    *   `ingestFn` validates, adds server timestamp (`dt` as 'yyyy-MM-dd'), and sends the raw JSON payload to the appropriate Firehose stream (`eventsStream` or `initialEventsStream`).

2.  **Delivery & Transformation:** Firehose (JSON -> Parquet) -> S3 (Partitioned Parquet)
    *   Firehose uses **Data Format Conversion** to transform the incoming JSON into Apache Parquet format based on the target Glue table schema.
    *   Firehose uses **Dynamic Partitioning** based on `site_id` and `dt` extracted from the JSON payload (via `processingConfiguration` with JQ).
    *   Parquet files are written to the `analyticsDataBucket` in Hive-style partitions (e.g., `s3://<bucket>/events/site_id=abc/dt=2024-01-01/`).
    *   S3 bucket uses Intelligent Tiering for cost optimization.

3.  **Catalog:** S3 (Parquet) -> Glue Data Catalog (Iceberg Tables)
    *   A Glue Database (`analyticsDatabase`) catalogs the tables.
    *   Two Glue Tables (`eventsTable`, `initialEventsTable`) are defined with `tableType: ICEBERG`.
    *   These tables point to the S3 base locations (`s3://<bucket>/events/`, `s3://<bucket>/initial_events/`) and define the schema and partitioning (`site_id`, `dt`).
    *   The Glue Iceberg tables manage the metadata layer over the underlying Parquet files stored in S3 by Firehose.

4.  **Query:** Dashboard -> API Gateway (`ManagementApi`) -> Lambda (`queryFn`) -> Athena
    *   Dashboard calls authenticated `/api/query` endpoint.
    *   `queryFn` Lambda constructs and runs Athena SQL queries against the Glue Iceberg tables.
    *   Athena uses the Glue Catalog and Iceberg metadata to efficiently query the Parquet data in S3. Results are stored in `athenaResultsBucket`.

5.  **Maintenance:** (Handled by Iceberg)
    *   Iceberg manages small file compaction automatically. Manual `OPTIMIZE TABLE` via Athena might be run periodically if needed, but the automated compaction function (`CompactionFn`/`CompactionCron`) has been removed.

---

## Future Plans
Later I'll add more "pay per use" alternatives to common website tools. Next would be comments with auto moderation, like Disqus ($20/m). Then webpage upvotes / downvotes and discoverability.