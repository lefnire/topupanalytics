# Migration Plan: DynamoDB to Aurora & Hybrid Analytics Storage

This plan outlines the steps to replace DynamoDB with Aurora Serverless v2 Postgres for transactional data and implement a hybrid storage model for analytics data (Aurora for recent, S3/Athena for historical), utilizing Drizzle ORM.

**Phase 1: Define Aurora Schema & Infrastructure (`sst.config.ts`)**

1.  **Define Aurora Tables (using Drizzle Schema):**
    *   We need tables to replace `SitesTable` and `UserPreferencesTable`, and new tables for analytics events. These will be defined using Drizzle ORM schema syntax (e.g., in `shared/db/schema.ts`).
    *   **`sites` Table:**
        *   `site_id` (TEXT PRIMARY KEY - ULIDs are strings)
        *   `owner_sub` (TEXT NOT NULL, INDEXED - For authorization checks)
        *   `name` (TEXT NOT NULL)
        *   `domains` (TEXT[] NOT NULL - Array of allowed hostnames)
        *   `plan` (TEXT NOT NULL DEFAULT 'free_tier', INDEXED)
        *   `request_allowance` (BIGINT NOT NULL DEFAULT 10000)
        *   `compliance_level` (SMALLINT NOT NULL DEFAULT 1 CHECK (compliance_level IN (0, 1, 2))) -- 0=yes, 1=maybe, 2=no
        *   `created_at` (TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
        *   `updated_at` (TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
        *   *(Optional: Add Stripe-related fields like `stripe_subscription_id` if needed later)*
    *   **`accounts` Table:** (Formerly `user_preferences`)
        *   `cognito_sub` (TEXT PRIMARY KEY)
        *   `email_notifications` (TEXT NOT NULL DEFAULT 'daily')
        *   `created_at` (TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
        *   `updated_at` (TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
        *   *(Optional: Add Stripe-related fields like `stripe_customer_id` if needed later)*
    *   **`events` Table (Analytics):**
        *   `event_id` (BIGSERIAL PRIMARY KEY - Auto-incrementing ID)
        *   `site_id` (TEXT NOT NULL, INDEXED)
        *   `session_id` (TEXT NOT NULL, INDEXED)
        *   `timestamp` (TIMESTAMPTZ NOT NULL, INDEXED)
        *   `dt` (DATE NOT NULL, INDEXED - For partitioning/querying by date)
        *   `event` (TEXT NOT NULL)
        *   `pathname` (TEXT NOT NULL)
        *   `properties` (JSONB)
        *   *(Consider adding indexes on `(site_id, timestamp)`, `(session_id, timestamp)`)*
    *   **`initial_events` Table (Analytics):**
        *   `event_id` (BIGSERIAL PRIMARY KEY)
        *   `site_id` (TEXT NOT NULL, INDEXED)
        *   `session_id` (TEXT NOT NULL, INDEXED)
        *   `timestamp` (TIMESTAMPTZ NOT NULL, INDEXED)
        *   `dt` (DATE NOT NULL, INDEXED)
        *   `event` (TEXT NOT NULL)
        *   `pathname` (TEXT NOT NULL)
        *   `properties` (JSONB)
        *   `referer` (TEXT)
        *   `referer_domain` (TEXT)
        *   `utm_source` (VARCHAR(255))
        *   `utm_medium` (VARCHAR(255))
        *   `utm_campaign` (VARCHAR(255))
        *   `utm_content` (VARCHAR(255))
        *   `utm_term` (VARCHAR(255))
        *   `device` (VARCHAR(100))
        *   `os` (VARCHAR(100))
        *   `browser` (VARCHAR(100))
        *   `country` (VARCHAR(100))
        *   `region` (VARCHAR(100))
        *   `city` (VARCHAR(100))
        *   `screen_width` (SMALLINT)
        *   `screen_height` (SMALLINT)
        *   *(Consider adding indexes similar to `events` table)*
    *   **Note on Data Types:** Using `TEXT` for IDs/names, `TEXT[]` for domains, `VARCHAR(n)` for UTM/device fields where reasonable limits exist, `JSONB` for flexible properties, `TIMESTAMPTZ` for timestamps, `DATE` for partitioning key `dt`, `BIGINT` for allowance, `SMALLINT` for screen dimensions and compliance level. This balances flexibility and storage efficiency. Drizzle schema definitions will map to these Postgres types.

2.  **Update `sst.config.ts`:**
    *   **Remove DynamoDB:** Delete the `sst.aws.Dynamo("SitesTable", ...)` and `sst.aws.Dynamo("UserPreferencesTable", ...)` resources.
    *   **Add Drizzle Migration Lambda:**
        *   Define a new `sst.aws.Function("DbMigrationFn", ...)`:
            *   `handler`: A new handler (e.g., `functions/migrations/migrate.handler`) that bundles `drizzle-kit` and executes the migration command against the linked database.
            *   `vpc`: Link to the same `vpc` as the Aurora DB.
            *   `link`: `database` (The Aurora resource).
            *   `copyFiles`: Include necessary migration files (`drizzle.config.ts`, migration SQL files).
            *   `timeout`: Sufficient time for migrations (e.g., "2 minutes").
            *   `environment`: Pass necessary DB connection info (SST likely injects via `database` link).
        *   **Trigger Migration:** Use `new aws.lambda.Invocation("DbMigrationTrigger", { functionName: migrationFn.name, /* ... other params like triggers */ });` to invoke the `DbMigrationFn` after the database and function are created/updated during `sst deploy`. This ensures the schema is ready.
    *   **Define HTTP Firehose:** Create a *new* `aws.kinesis.FirehoseDeliveryStream` named `IngestHttpFirehose` (or similar).
        *   `destination: "http_endpoint"`
        *   `httpEndpointConfiguration`:
            *   `url`: Link to the URL of the new `processIngestFn` Lambda (see below).
            *   `name`: "ProcessIngestLambda"
            *   `bufferingSize`: 15 (Max MB for HTTP destination)
            *   `bufferingInterval`: 60 (Seconds)
            *   `roleArn`: Use the existing `firehoseDeliveryRole.arn` (or create a new minimal one if preferred, but existing should have S3 backup perms).
            *   `s3BackupMode`: "FailedDataOnly"
            *   `s3Configuration`: Point to a specific prefix in `analyticsDataBucket` for failed records (e.g., `s3://${analyticsDataBucket.name}/http-firehose-failures/`).
            *   `requestConfiguration.contentEncoding`: "GZIP" (Lambda needs to handle Gzipped input).
    *   **Define `processIngestFn`:** Create a new `sst.aws.Function("ProcessIngestFn", ...)`:
        *   `handler`: `functions/analytics/processIngest.handler` (new file).
        *   `url: true` (To provide the HTTP endpoint for the Firehose).
        *   `timeout`: Increase significantly (e.g., "5 minutes") to handle bulk processing.
        *   `memory`: Increase (e.g., "1024 MB") for bulk inserts and caching.
        *   `vpc`: Link to the same `vpc` as the Aurora DB.
        *   `link`:
            *   `database` (The Aurora resource)
            *   `firehoses.events` (Existing S3/Iceberg Firehose)
            *   `firehoses.initial_events` (Existing S3/Iceberg Firehose)
        *   `permissions`: Needs `firehose:PutRecordBatch` for the S3/Iceberg streams. Database access permissions are handled via VPC/security groups implicitly by SST linking the `database` to the function within the `vpc`.
        *   `environment`: Pass `AURORA_DB_NAME`, `AURORA_SECRET_ARN`, `AURORA_CLUSTER_ARN` (SST might inject these via `database` link, confirm/adjust).
    *   **Update `ingestFn`:**
        *   Remove `link` entries for `sitesTable`, `userPreferencesTable`, `firehoses.events`, `firehoses.initial_events`.
        *   Add `link` entry for the new `IngestHttpFirehose`.
        *   Remove DynamoDB-related permissions. Add `firehose:PutRecord` permission for the new HTTP Firehose.
        *   Simplify `memory` and `timeout` if possible (e.g., "128 MB", "5 seconds").
    *   **Update `queryFn`:**
        *   Remove `link` entries for `sitesTable`, `userPreferencesTable`.
        *   Add `link` entry for `database` (Aurora).
        *   Add `vpc` configuration to place it in the same VPC as Aurora.
        *   Update `permissions`: Remove DynamoDB permissions. Database access handled by VPC/linking. Keep Athena/S3/Glue permissions.
        *   Update `environment` as needed (DB connection info).
    *   **Update `sitesFn`:**
        *   Remove `link` entry for `sitesTable`.
        *   Add `link` entry for `database` (Aurora).
        *   Add `vpc` configuration.
        *   Update `permissions`: Remove DynamoDB permissions.
        *   Update `environment` as needed.
    *   **Update `preferencesFn` (to be renamed `accountsFn`):**
        *   Rename the function resource in `sst.config.ts` (e.g., `AccountsFn`).
        *   Update the handler path (e.g., `functions/api/accounts.handler`).
        *   Remove `link` entry for `userPreferencesTable`.
        *   Add `link` entry for `database` (Aurora).
        *   Add `vpc` configuration.
        *   Update `permissions`: Remove DynamoDB permissions.
        *   Update `environment` as needed.
    *   **Update API Gateway Routes:** Update routes pointing to `preferencesFn` to point to the new `accountsFn`.
    *   **Update S3/Iceberg Firehose Buffering:** Modify `firehoses.events` and `firehoses.initial_events` `icebergConfiguration` to use max buffering (`bufferingInterval: 900`, `bufferingSize: 128`) as this data is now less time-sensitive.
    *   **Review Security Groups:** Ensure the Lambda functions (`DbMigrationFn`, `processIngestFn`, `queryFn`, `sitesFn`, `accountsFn`) placed in the VPC can communicate with the Aurora cluster on the correct port (5432). SST usually handles this when linking `database` to functions within the `vpc`.

**Phase 2: Implement Code Changes**

1.  **Add Drizzle ORM & Dependencies:** Add `drizzle-orm`, `drizzle-kit`, and the appropriate driver (`pg`) to `package.json` dependencies/devDependencies.
2.  **Create Shared Drizzle Schema:** Define table schemas in a shared location (e.g., `shared/db/schema.ts`) using Drizzle syntax.
3.  **Create DB Helper/Client:** Create a shared utility (e.g., `shared/db/client.ts`) to initialize the Drizzle client using credentials from SST (`Resource.Database`). **Crucially, implement connection pooling suitable for Lambda (e.g., use RDS Proxy if available, or manage connections carefully to avoid exhausting pool limits in concurrent executions).**
4.  **Modify `functions/analytics/ingest.ts`:**
    *   Remove all code related to DynamoDB access, site config caching, allowance checking, domain validation, data enrichment, and compliance filtering.
    *   Keep the initial `siteId` extraction from query parameters.
    *   Parse the request body.
    *   Construct a simple JSON payload containing the raw event data *and* the `site_id`.
    *   Use the AWS SDK to send this single record to the new `IngestHttpFirehose` stream name (obtained from `Resource`).
5.  **Create `functions/analytics/processIngest.handler`:**
    *   **Input:** Function will receive batches of records from the HTTP Firehose (likely Gzipped, needs decompression). Each record contains the raw event + `site_id`.
    *   **Processing Loop:** Iterate through the batch of records.
    *   **Site Config:** For each unique `site_id` in the batch, fetch its config (`domains`, `compliance_level`, `request_allowance`, `owner_sub`) from the Aurora `sites` table using the shared Drizzle client. Implement caching (Map-based) to minimize DB hits within a single invocation. Remember `compliance_level` is now 0, 1, or 2.
    *   **Filtering/Validation:** For each record:
        *   Perform domain validation using the cached site config. Skip invalid records.
        *   Perform allowance check against cached allowance. Skip records if allowance <= 0.
        *   Perform data enrichment (geo, device, referer) for initial events.
        *   Perform compliance filtering based on cached `compliance_level` (0, 1, 2).
        *   Keep track of valid, processed records destined for Aurora and S3/Iceberg. Keep track of allowance decrements per `site_id`.
    *   **Bulk Insert to Aurora:**
        *   Group valid records by type (`events`, `initial_events`).
        *   **Evaluate Drizzle's bulk insert (`db.insert().values(...)`) vs. raw SQL (`COPY FROM STDIN` via `db.execute(sql\``...`)`) for performance.** Choose the most efficient method for inserting potentially large batches into `events` and `initial_events`. Handle potential errors.
    *   **Forward to S3/Iceberg Firehose:**
        *   Group the *same* valid records by type (`events`, `initial_events`).
        *   Use the AWS SDK's `FirehoseClient` and `PutRecordBatchCommand` to send these records to the *original* S3/Iceberg Firehose streams (`Resource.FirehoseStreamevents.name`, `Resource.FirehoseStreaminitial_events.name`). Handle potential errors/retries.
    *   **Update Allowance:**
        *   After successful Aurora inserts and Firehose forwarding, update the `request_allowance` in the Aurora `sites` table for the affected `site_id`s using Drizzle's `update` statement with a decrement and condition (`.where(and(eq(sites.siteId, siteId), gte(sites.requestAllowance, decrementCount)))`). Consider transaction safety if needed.
6.  **Modify `functions/analytics/query.ts`:**
    *   Replace DynamoDB ownership check with a Drizzle query against the `sites` table (`db.select(...).from(sites).where(eq(sites.ownerSub, ...))`).
    *   Parse `startDate` and `endDate`.
    *   Calculate `thirtyDaysAgo`.
    *   **Conditional Logic:**
        *   If `startDate >= thirtyDaysAgo`:
            *   Construct Drizzle queries against Aurora `events` and `initial_events` tables using date range and authorized `site_id` filters (`db.select(...).from(events).where(and(inArray(events.siteId, ...), gte(events.timestamp, ...), lte(events.timestamp, ...)))`).
            *   Execute queries using the Drizzle client.
            *   Parse results.
        *   Else (`startDate < thirtyDaysAgo`):
            *   Use the *existing* Athena query logic (`executeAthenaQuery`).
    *   Return combined/chosen results.
7.  **Modify `functions/api/sites.ts`:**
    *   Remove DynamoDB client/commands.
    *   Use the shared Drizzle client and schema.
    *   Rewrite handlers (`POST /`, `GET /`, `GET /{id}`, `PUT /{id}`) using Drizzle ORM (`db.insert`, `db.select`, `db.update`) against the `sites` table. Ensure `owner_sub` checks are included in `where` clauses. Adapt `compliance_level` handling.
8.  **Rename and Modify `functions/api/preferences.ts` to `functions/api/accounts.ts`:**
    *   Rename the file.
    *   Update handler function name.
    *   Remove DynamoDB client/commands.
    *   Use the shared Drizzle client and schema.
    *   Rewrite `GET` and `PUT` handlers using Drizzle ORM (`db.select`, `db.update`, potentially `db.insert` on GET) against the `accounts` table, using `cognito_sub` in the `where` clause. Remove logic related to the `theme` field.
9.  **Implement `functions/migrations/migrate.handler`:**
    *   This handler will need to:
        *   Import the Drizzle client configuration.
        *   Bundle or have access to `drizzle-kit`.
        *   Execute the equivalent of `drizzle-kit migrate` programmatically or via a child process.
        *   Handle potential errors during migration.

**Phase 3: Documentation**

1.  **Update `README.md`:** (Skipped as per request) Revise the "Data Pipeline" section to accurately reflect the new architecture involving the HTTP Firehose, `processIngestFn`, Aurora for recent data, Drizzle ORM, the migration Lambda, and the hybrid query approach.

**Diagram: New Ingest Flow**

```mermaid
graph LR
    Client --> Router[Public Router / CloudFront];
    Router --> IngestFn[Lambda: ingestFn];
    IngestFn -- Raw Event + site_id --> HttpFirehose[Firehose: IngestHttpFirehose (HTTP Dest)];
    HttpFirehose -- Batched Events (Gzip) --> ProcessFn[Lambda: processIngestFn (VPC)];

    subgraph ProcessFn Logic
        direction TB
        Cache{Site Config Cache};
        ProcessFn -- Load/Cache (Drizzle) --> AuroraSites[Aurora: sites];
        ProcessFn -- Validate/Filter/Enrich --> ValidEvents{Valid Events};
        ValidEvents -- Bulk Insert (Drizzle/SQL) --> AuroraEvents[Aurora: events/initial_events];
        ValidEvents -- PutRecordBatch --> S3Firehose[Firehose: S3/Iceberg Streams];
        ProcessFn -- Update Allowance (Drizzle) --> AuroraSites;
    end

    S3Firehose --> S3Bucket[S3: analyticsDataBucket (Parquet)];
    S3Bucket --> Glue[Glue Catalog (Iceberg)];

    style ProcessFn fill:#f9f,stroke:#333,stroke-width:2px
    style AuroraSites fill:#ccf,stroke:#333,stroke-width:2px
    style AuroraEvents fill:#ccf,stroke:#333,stroke-width:2px
```

**Diagram: New Query Flow**

```mermaid
graph LR
    Dashboard --> APIGW[API Gateway: ManagementApi];
    APIGW -- /api/query --> QueryFn[Lambda: queryFn (VPC)];

    subgraph QueryFn Logic
        direction TB
        QueryFn -- Check Ownership (Drizzle) --> AuroraSites[Aurora: sites];
        QueryFn -- Date Range Check --> DecideSource{<=30d?};
        DecideSource -- Yes --> QueryAurora[Query Aurora (Drizzle)];
        DecideSource -- No --> QueryAthena[Query Athena via Glue/S3];
        QueryAurora --> FormatResults;
        QueryAthena --> FormatResults;
    end

    QueryAurora -- SQL (via Drizzle) --> AuroraEvents[Aurora: events/initial_events];
    QueryAthena -- SQL --> Athena;
    Athena --> Glue[Glue Catalog (Iceberg)];
    Glue --> S3Bucket[S3: analyticsDataBucket (Parquet)];
    Athena --> S3Results[S3: athenaResultsBucket];


    QueryFn --> APIGW;
    APIGW --> Dashboard;

    style QueryFn fill:#f9f,stroke:#333,stroke-width:2px
    style AuroraSites fill:#ccf,stroke:#333,stroke-width:2px
    style AuroraEvents fill:#ccf,stroke:#333,stroke-width:2px
```

**Phase 4: Deployment & Testing**

1.  Deploy the updated stack (`sst deploy`). Verify the `DbMigrationFn` runs successfully via the `aws.lambda.Invocation` trigger.
2.  Test all API endpoints (`/sites`, `/accounts`, `/query`) to ensure they interact correctly with Aurora using Drizzle.
3.  Test the ingest pipeline by sending events and verifying data appears in both Aurora (for recent events via `processIngestFn`) and S3/Athena (via the forwarded Firehose streams).
4.  Monitor CloudWatch logs for all involved Lambda functions (`ingestFn`, `processIngestFn`, `queryFn`, `sitesFn`, `accountsFn`, `DbMigrationFn`) for errors.
5.  Perform load testing on the ingest endpoint if necessary.