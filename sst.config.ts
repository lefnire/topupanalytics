/// <reference path="./.sst/platform/config.d.ts" />

/*
## Data Pipeline: Cost-Optimized & Scalable Analytics

The primary goal of this data pipeline is extreme cost-effectiveness and scalability, aiming to support a high volume of events and queries affordably. The core AWS services used are Kinesis Firehose, S3, Glue, Athena, Lambda, CloudFront (via SST Router), and API Gateway V2.

## Next Steps / Missing Components

This IaC configures the core data pipeline and basic routing, but several components are needed to realize the full web analytics product:

1.  **API Gateway Routes (for Management):**
    *   Define authenticated routes within the `ManagementApi` (`ApiGatewayV2`) for user/site management (these are lower volume and protected, justifying API Gateway cost):
        *   `POST /api/sites`: Create a new site entry in `sitesTable` linked to the authenticated Cognito user.
        *   `GET /api/sites`: List sites belonging to the user.
        *   `GET /api/sites/{site_id}`: Get details for a specific site (including configuration).
        *   `PUT /api/sites/{site_id}`: Update site configuration (e.g., domains, allowed fields for GDPR).
        *   `GET /api/sites/{site_id}/script`: Generate the JS embed script tag.
    *   Define routes for user preferences (`userPreferencesTable`).
    *   Stripe integration endpoints (webhook for payment confirmation, initiating checkout).
    *   **Note:** The `/api/query` route is already configured on this API Gateway.
2.  **Lambda Function Logic:**
    *   Implement logic within backend functions (new Lambdas or potentially adding logic to `queryFn`) to handle the management API routes (CRUD for `sitesTable`, `userPreferencesTable`, Stripe interactions). These new functions will need linking to the `ManagementApi`.
    *   `ingestFn`: Modify to:
        *   Extract `site_id` (e.g., from a query param or header specified in the embed script).
        *   Validate `site_id` against `sitesTable` (ensure it exists and potentially check allowed domains against `Referer`).
        *   Fetch site config (e.g., GDPR field preferences) from `sitesTable`.
        *   Extract relevant data points from the request body and the headers forwarded by CloudFront (via the Router).
        *   Filter event fields based on site config *before* sending to Firehose.
        *   Send the processed record to the appropriate Firehose stream.
    *   `queryFn`: Ensure queries are correctly scoped to the `site_id`(s) owned by the authenticated user (using the `ownerSubIndex` on `sitesTable`). Implement pagination/filtering.
    *   Script Generation Logic: Function (invoked by `GET /api/sites/{site_id}/script`) to create the JS snippet embedding the `site_id` and the public Router ingest endpoint URL (`/api/event`).
3.  **Frontend Dashboard (`Dashboard` React App):**
    *   Implement UI flows for user authentication (sign up, login, etc. using Cognito).
    *   Build UI for site management (create, list, configure fields, get script tag) interacting with the `ManagementApi` endpoints.
    *   Integrate Stripe Elements/Checkout for payments.
    *   Develop analytics visualizations: Fetch data from `/api/query` (via `ManagementApi`), perform client-side processing/joining (DuckDB WASM), display charts/tables.

## Potential Architectural Improvements

While the current setup focuses on cost/scale, consider these enhancements:

*   **Cost/Scalability:**
    *   **Ingestion Sampling:** Introduce sampling (client-side or in `ingestFn`) for high-traffic sites or lower tiers to reduce data volume.
    *   **Pre-Aggregation:** For common dashboard views (e.g., daily uniques, top pages), use scheduled Athena CTAS queries to create materialized summary tables (Iceberg). This speeds up reads and cuts query costs at the expense of some storage/complexity.
    *   **Data Archival/Tiering:** Beyond S3 Intelligent Tiering, implement stricter lifecycle policies to archive or delete raw event data after a defined period if feasible, relying on summaries for long-term trends.
*   **Performance:**
    *   **Query API Optimization:** Implement robust pagination, filtering, and potentially projection in the `/api/query` Lambda to minimize data transfer to the client.
    *   **Dashboard Caching:** Utilize browser caching or state management libraries to cache fetched analytics data effectively.
    *   **Consider Read-Optimized Store:** If Athena latency/cost becomes prohibitive at extreme scale for *interactive* queries, explore replicating aggregated/hot data to a faster store (e.g., DynamoDB, OpenSearch, ClickHouse Cloud), though this adds significant complexity.
*   **Operations & Security:**
    *   **Site ID Security:** Ensure robust validation of `site_id` in `ingestFn`. Consider verifying the `Referer` header against the domains configured in `sitesTable` for that `site_id` as an additional check.
    *   **Monitoring & Alerting:** Add CloudWatch Alarms for function errors, Firehose failures, high Athena costs, compaction failures, and API Gateway/CloudFront (Router) metrics (latency, errors, cache hit rate).
    *   **Rate Limiting:** Configure WAF/rate limiting on the public ingest CloudFront distribution used by the `Router`.

---
*Existing Pipeline Description:*

#### 1. Ingest: Client -> Router (CloudFront) -> Lambda (`ingestFn`) -> Firehose -> S3 (Parquet)

- **Entrypoint:** Events are sent to the `sst.aws.Router` endpoint (e.g., `https://yourdomain.com/api/event` or the CloudFront URL).
- **Routing:** The Router (using CloudFront + CF Functions) directs `/api/event` requests to the `ingestFn`'s Lambda Function URL. It automatically forwards relevant CloudFront headers (geo, user-agent, etc.).
- **Processing:** The `ingestFn` Lambda receives the event payload and headers. It validates the `site_id`, distinguishes between initial/subsequent events, filters based on site config, and extracts necessary fields.
- **Delivery:** The Lambda sends the data to one of two Kinesis Firehose streams: `initial-events-stream` or `events-stream`.
- **Firehose to S3:** Firehose uses **dynamic partitioning** based on `site_id` and `dt` to write data directly into the `eventsBucket` S3 bucket as **Parquet** files (SNAPPY compressed). S3 buckets utilize **Intelligent Tiering**.

#### 2. Storage & Catalog: S3 -> Glue (Hive + Iceberg)

- **Raw Data:** Parquet files reside in the `eventsBucket`.
- **Glue Hive Tables:** Two traditional Glue external tables (`initial_events`, `events`) are defined over the S3 paths, using **partition projection**.
- **Glue Iceberg Tables:** An `IcebergInitFn` Lambda creates **Apache Iceberg** tables (`initial_events_iceberg`, `events_iceberg`) via Athena CTAS upon deployment.

#### 3. Query: Dashboard -> API Gateway (`ManagementApi`) -> Lambda (`queryFn`) -> Athena (Querying Iceberg)

- **Entrypoint:** Users query data via the dashboard, hitting `GET /api/query` on the `ManagementApi` endpoint (e.g., `https://api.yourdomain.com/api/query`).
- **Authentication:** API Gateway validates the Cognito JWT token using the configured authorizer.
- **Execution:** The `queryFn` Lambda receives the request, constructs an Athena query scoped to the user's `site_id`(s), and executes it against the **Iceberg tables**.
- **Client-Side Join:** Joining `initial_events` and `events` data happens client-side (DuckDB WASM).

#### 4. Maintenance: Cron -> Lambda -> Athena (Iceberg Compaction)

- **Trigger:** A `CompactionCron` triggers the `CompactionFn` Lambda hourly.
- **Action:** This Lambda executes Athena `OPTIMIZE` commands on the **Iceberg tables** to compact small files.
 */


const domain = "topupanalytics.com"
export default $config({
  app(input) {
    return {
      name: "topupanalytics",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
    };
  },
  async run() {
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId
    const region = aws.getRegionOutput().name

    // === Linkable Wrappers (using global sst) ===
    // Wrap Kinesis Firehose Delivery Stream
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: { name: stream.name },
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [stream.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Database
    sst.Linkable.wrap(aws.glue.CatalogDatabase, (db) => ({
      properties: { name: db.name, arn: db.arn },
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetDatabase"],
          resources: [db.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Table
    sst.Linkable.wrap(aws.glue.CatalogTable, (table) => ({
      properties: { name: table.name, arn: table.arn, databaseName: table.databaseName },
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions", "glue:GetPartition", "glue:GetPartitions"], // Read actions
          resources: [table.arn, $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, $interpolate`arn:aws:glue:${region}:${accountId}:database/${table.databaseName}`], // Include DB ARN
        }),
      ],
    }));

    // === Configuration ===
    const baseName = `${$app.name}-${$app.stage}`;

    // === S3 Buckets ===
    const eventsBucket = new sst.aws.Bucket("EventData", {});
    const queryResultsBucket = new sst.aws.Bucket("AthenaResults", {});

    // === Common S3 Lifecycle Rule for Intelligent Tiering ===
    const intelligentTieringRule: aws.types.input.s3.BucketLifecycleConfigurationV2Rule[] = [{
        id: "IntelligentTieringRule",
        status: "Enabled",
        filter: {}, // Apply rule to all objects
        transitions: [{
            days: 0,
            storageClass: "INTELLIGENT_TIERING",
        }],
    }];

    // Apply lifecycle rule to Events Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`${baseName}-event-data-lifecycle`, {
        bucket: eventsBucket.name,
        rules: intelligentTieringRule,
    });

    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`${baseName}-athena-results-lifecycle`, {
        bucket: queryResultsBucket.name,
        rules: intelligentTieringRule,
    });

    // === Glue Data Catalog ===
    const analyticsDatabase = new aws.glue.CatalogDatabase(`${baseName}-db`, {
      name: `${baseName}_analytics_db`, // Glue names often use underscores
    });

    // Import schemas for both tables
    const { initialGlueColumns, eventsGlueColumns } = await import('./functions/analytics/schema');

    // Define partition keys once for consistency
    const commonPartitionKeys = [
      { name: "site_id", type: "string" },
      { name: "dt", type: "string" },
    ];

    // Create table for initial events (contains all session data) - Original Glue Table
    const initialEventsTable = new aws.glue.CatalogTable(`${baseName}-initial-events-table`, {
      name: `initial_events`,
      databaseName: analyticsDatabase.name,
      tableType: "EXTERNAL_TABLE",
      parameters: {
        "external": "TRUE", "parquet.compression": "SNAPPY", "classification": "parquet",
        "projection.enabled": "true", "projection.dt.type": "date", "projection.dt.format": "yyyy-MM-dd",
        "projection.dt.range": "2020-01-01,NOW", "projection.site_id.type": "injected", // Phase 3.2: Add site_id projection type
        "storage.location.template": $interpolate`s3://${eventsBucket.name}/initial_events/site_id=\${site_id}/dt=\${dt}/`,
      },
      storageDescriptor: {
        location: $interpolate`s3://${eventsBucket.name}/initial_events/`,
        inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
        serDeInfo: { name: "parquet-serde", serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe", parameters: { "serialization.format": "1" } },
        columns: initialGlueColumns, compressed: false, storedAsSubDirectories: true,
      },
      partitionKeys: commonPartitionKeys,
    });

    // Create table for regular events (contains minimal data) - Original Glue Table
    const eventsTable = new aws.glue.CatalogTable(`${baseName}-events-table`, {
      name: `events`,
      databaseName: analyticsDatabase.name,
      tableType: "EXTERNAL_TABLE",
      parameters: {
        "external": "TRUE", "parquet.compression": "SNAPPY", "classification": "parquet",
        "projection.enabled": "true", "projection.dt.type": "date", "projection.dt.format": "yyyy-MM-dd",
        "projection.dt.range": "2020-01-01,NOW", "projection.site_id.type": "injected", // Phase 3.2: Add site_id projection type
        "storage.location.template": $interpolate`s3://${eventsBucket.name}/events/site_id=\${site_id}/dt=\${dt}/`,
      },
      storageDescriptor: {
        location: $interpolate`s3://${eventsBucket.name}/events/`,
        inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
        serDeInfo: { name: "parquet-serde", serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe", parameters: { "serialization.format": "1" } },
        columns: eventsGlueColumns, compressed: false, storedAsSubDirectories: true,
      },
      partitionKeys: commonPartitionKeys,
    });

    // === Iceberg Tables (Created via Invoked Lambda below) ===
    // Custom Resource / dynamic.Resource removed
    // class AthenaQueryExecutorProvider implements dynamic.ResourceProvider { /* ... removed ... */ }
    // new dynamic.Resource(`${baseName}-InitialEventsIcebergInit`, { /* ... removed ... */ });
    // new dynamic.Resource(`${baseName}-EventsIcebergInit`, { /* ... removed ... */ });

    // === Iceberg Table Initialization Function ===
    const icebergInitFn = new sst.aws.Function("IcebergInitFn", {
      handler: "functions/infra/iceberg-init.handler", // New handler path
      timeout: "5 minutes", // Might take time
      memory: "256 MB",
      architecture: "arm64",
      link: [
        analyticsDatabase,
        initialEventsTable,
        eventsTable,
        eventsBucket,
        queryResultsBucket
      ],
      environment: { // Only pass values not available via linked resources
        INITIAL_EVENTS_ICEBERG_TABLE_NAME: "initial_events_iceberg", // String constant
        EVENTS_ICEBERG_TABLE_NAME: "events_iceberg",           // String constant
        ATHENA_WORKGROUP: "primary", // String constant
      },
      permissions: [
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"], resources: ["*"] }, // Specific Athena actions
        { actions: ["glue:CreateTable", "glue:GetTable", "glue:GetDatabase"], resources: [ // Specific Glue actions
            analyticsDatabase.arn, // Database ARN from link
            initialEventsTable.arn, // Source Table ARN from link
            eventsTable.arn,        // Source Table ARN from link
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Catalog access often needed
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${analyticsDatabase.name}/*`, // Access to tables within the DB
          ]
        },
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"], resources: [ // S3 permissions for Athena/Iceberg
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`,
            queryResultsBucket.arn, // Athena needs access to results bucket too
            $interpolate`${queryResultsBucket.arn}/*`
          ]
        },
      ],
      nodejs: {
        install: ["@aws-sdk/client-athena"],
      }
    });

    // === Invoke Iceberg Initialization Function ===
    // Only pass data not available via linked resources as input
    const icebergInitInput ={
        INITIAL_EVENTS_ICEBERG_TABLE_NAME: "initial_events_iceberg",
        EVENTS_ICEBERG_TABLE_NAME: "events_iceberg",
        ATHENA_WORKGROUP: "primary",
    };

    new aws.lambda.Invocation(`${baseName}-IcebergInitInvocation`, {
        functionName: icebergInitFn.name,
        input: $util.jsonStringify(icebergInitInput),
        triggers: {
           redeployment: Date.now().toString(),
        },
      }, { dependsOn: [icebergInitFn, initialEventsTable, eventsTable] }
    );

    // === IAM Role for Firehose ===
    const firehoseRole = new aws.iam.Role(`${baseName}-firehose-role`, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // === Firehose Processor Function (DELETED in Phase 3.1) ===
    // const firehoseProcessorFn = new sst.aws.Function("FirehoseProcessorFn", { ... });

    // Allow Firehose to write to S3 and access Glue
    new aws.iam.RolePolicy(`${baseName}-firehose-policy`, {
      role: firehoseRole.id,
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          { "Effect": "Allow", "Action": ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], "Resource": ["${eventsBucket.arn}", "${eventsBucket.arn}/*"] },
          { "Effect": "Allow", "Action": ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"], "Resource": ["${analyticsDatabase.arn}", "${eventsTable.arn}", "${initialEventsTable.arn}", "arn:aws:glue:${region}:${accountId}:catalog"] },
          { "Effect": "Allow", "Action": [ "logs:PutLogEvents" ], "Resource": "arn:aws:logs:*:*:log-group:/aws/kinesisfirehose/*:*" }
        ]
      }`,
    });

    // === Kinesis Data Firehose Delivery Streams ===
    const eventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`${baseName}-events-stream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseRole.arn, bucketArn: eventsBucket.arn,
        prefix: "events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/", // Phase 3.1: Use partitionKeyFromQuery
        errorOutputPrefix: "errors/events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/", // Phase 3.1: Use partitionKeyFromQuery
        bufferingInterval: 60, bufferingSize: 64, compressionFormat: "UNCOMPRESSED",
        dynamicPartitioningConfiguration: { enabled: true }, // Phase 3.1: Enable dynamic partitioning
        dataFormatConversionConfiguration: {
          enabled: true, inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
          schemaConfiguration: { databaseName: analyticsDatabase.name, tableName: eventsTable.name, roleArn: firehoseRole.arn },
        },
        // processingConfiguration removed in Phase 3.1
      },
    });

    const initialEventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`${baseName}-initial-events-stream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseRole.arn, bucketArn: eventsBucket.arn,
        prefix: "initial_events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/", // Phase 3.1: Use partitionKeyFromQuery
        errorOutputPrefix: "errors/initial_events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/", // Phase 3.1: Use partitionKeyFromQuery
        bufferingInterval: 60, bufferingSize: 64, compressionFormat: "UNCOMPRESSED",
        dynamicPartitioningConfiguration: { enabled: true }, // Phase 3.1: Enable dynamic partitioning
        dataFormatConversionConfiguration: {
          enabled: true, inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
          schemaConfiguration: { databaseName: analyticsDatabase.name, tableName: initialEventsTable.name, roleArn: firehoseRole.arn },
        },
        // processingConfiguration removed in Phase 3.1
      },
    });

    // === Cognito User Pool ===
    const userPool = new aws.cognito.UserPool("UserPool", {
        name: `${baseName}-user-pool`, aliasAttributes: ["email"], autoVerifiedAttributes: ["email"],
    });
    const userPoolClient = new aws.cognito.UserPoolClient("UserPoolClient", {
        name: `${baseName}-user-pool-client`, userPoolId: userPool.id, generateSecret: false,
        explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    });

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      fields: { site_id: "string", owner_sub: "string", domains: "string", plan: "string" },
      primaryIndex: { hashKey: "site_id" },
      globalIndexes: {
        // GSI for querying sites by owner
        ownerSubIndex: { hashKey: "owner_sub", projection: ["site_id"] }, // Corrected: Use hashKey
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      fields: { cognito_sub: "string", theme: "string", email_notifications: "string", plan_tier: "string" },
      primaryIndex: { hashKey: "cognito_sub" },
    });

    // === Router for Public Endpoints (Ingest + Dashboard) ===
    const router = new sst.aws.Router("PublicRouter", {
      domain: isProd ? domain : undefined, // Use custom domain in prod
    });

    // === API Functions (Defined before Router/API Gateway attachments) ===
    const ingestFn = new sst.aws.Function("IngestFn", {
        handler: "functions/analytics/ingest.handler",
        timeout: '10 second',
        memory: "128 MB",
        // url: true, // Keep url enabled, but attach to router for public access
        url: {
          router: {
            instance: router,
            path: "/api/event", // Route /api/event via Router
            // method: "POST", // Method filtering happens in function or via Router config if available elsewhere
          }
        },
        link: [
          eventsFirehoseStream,
          initialEventsFirehoseStream,
          sitesTable
        ],
        permissions: [
          // Permission to query sitesTable is needed for validation
          { actions: ["dynamodb:GetItem"], resources: [sitesTable.arn] },
          { actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`] } // Keep query if needed elsewhere? Revisit. GetItem is likely sufficient for site validation.
        ],
    });

    const queryFn = new sst.aws.Function("QueryFn", {
        handler: "functions/analytics/query.handler",
        timeout: "60 second",
        memory: "512 MB",
        // NOTE: queryFn is NOT attached to the public Router
        // It will be attached to the authenticated ApiGatewayV2 below
        link: [
           analyticsDatabase,
           queryResultsBucket,
           eventsBucket,
           sitesTable,
           userPreferencesTable
        ],
        environment: { // Only pass values not available via linked resources
            ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // String constant
            ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // String constant
        },
        permissions: [
          { actions: ["athena:*"], resources: ["*"] },
          { actions: ["s3:ListBucket"], resources: [ queryResultsBucket.arn, eventsBucket.arn ] },
          // Permission to query sitesTable needed to scope results
          { actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`] },
          // Permission to get user preferences
          { actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn] },
        ],
    });


    // === API Gateway (for Authenticated Endpoints like /api/query) ===
    const api = new sst.aws.ApiGatewayV2("ManagementApi", { // Renamed for clarity
      domain: isProd ? {
        name: `api.${domain}`, // Suggest using a subdomain like api.* for management endpoints
        // redirects property removed - not valid for ApiGatewayV2
      } : undefined,
      cors: { // CORS needed for dashboard interaction
        allowOrigins: isProd ? [`https://${domain}`] : ["*"], // Allow origin from the main dashboard domain
        allowCredentials: true, // Important if auth cookies/headers are used
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allow necessary methods
        allowHeaders: ["Content-Type", "Authorization"], // Allow standard headers + Auth
      },
    });

    // Define JWT Authorizer (Phase 1.3 / Implicit from original config)
    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClient.id],
      }
    });

    // Define Query Route on the Management API Gateway
    api.route(
      "GET /api/query",
      "functions/analytics/query.handler", // Provide the handler path directly
      {
        // Link the function for permissions/env vars if not implicitly linked
        // link: [queryFn], // Remove: Rely on implicit linking via handler string
        // Inherit timeout/memory if desired (or let Lambda have its own)
        // timeout: queryFn.timeout,
        // memory: queryFn.memory,
        auth: { // Auth config goes in the options object
          jwt: {
            authorizer: jwtAuthorizer.id
          }
        }
      }
    );

    // === Dashboard (React Frontend) ===
    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      // Attach dashboard to the root of the public Router
      router: {
        instance: router,
        // path defaults to "/*" when attaching a site like this
      },
      // Link API Gateway for authenticated calls (/api/query)
      // Link UserPool/Client for frontend auth logic
      link: [api, userPool, userPoolClient],
      environment: {
        VITE_COGNITO_USER_POOL_ID: userPool.id,
        VITE_COGNITO_CLIENT_ID: userPoolClient.id,
        VITE_AWS_REGION: region,
        // Pass the API Gateway URL for authenticated calls
        VITE_API_URL: api.url,
        // Pass the Router URL/domain for context if needed, though ingest URL comes from script tag
        VITE_APP_URL: router.url,
      },
    });

    // === Compaction Function ===
    const compactionFn = new sst.aws.Function("CompactionFn", {
      handler: "functions/analytics/compact.handler",
      timeout: "15 minutes", memory: "512 MB", architecture: "arm64",
      link: [
        analyticsDatabase,
        eventsBucket,
        queryResultsBucket
      ],
       environment: { // Only pass values not available via linked resources
            ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // String constant
            ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // String constant
        },
      permissions: [
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"], resources: ["*"] }, // Specific Athena actions for OPTIMIZE/CTAS
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads", "s3:AbortMultipartUpload"], resources: [ // Broad S3 access needed for compaction/manifests
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`,
            queryResultsBucket.arn, // Access results bucket too
            $interpolate`${queryResultsBucket.arn}/*`
          ]
        },
        { actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions", "glue:UpdateTable", "glue:UpdatePartition", "glue:BatchUpdatePartition"], resources: [ // Glue Read/Update for compaction metadata
            analyticsDatabase.arn, // Database ARN from link
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Catalog access
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${analyticsDatabase.name}/*`, // Access to manage tables within the DB (incl. Iceberg)
            initialEventsTable.arn, // Grant access to original tables too if needed
            eventsTable.arn,
          ]
        },
      ],
    });

    // Phase 4.C: Add Cron job for compaction
    new sst.aws.Cron("CompactionCron", {
      schedule: "cron(5 * * * ? *)", // Hourly at 5 past the hour
      function: compactionFn.arn // Use the ARN of the existing compactionFn
    });

    // === Outputs ===
    return {
      appName: $app.name,
      accountId: accountId,
      compactionFunctionName: compactionFn.name,
      // dashboardUrl: dashboard.url, // URL now comes from the router
      dashboardUrl: router.url, // Use router URL for dashboard access
      // apiUrl: api.url, // Keep API Gateway URL for management endpoints
      managementApiUrl: api.url, // Rename output for clarity
      // ingestFunctionUrl: ingestFn.url, // Ingest URL is via the router now
      publicIngestUrl: $interpolate`${router.url}/api/event`, // Construct ingest URL from router
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      dataBucketName: eventsBucket.name,
      queryResultsBucketName: queryResultsBucket.name,
      eventsFirehoseStreamName: eventsFirehoseStream.name,
      initialEventsFirehoseStreamName: initialEventsFirehoseStream.name,
      glueDatabaseName: analyticsDatabase.name,
      eventsTableName: eventsTable.name,
      initialEventsTableName: initialEventsTable.name,
      initialEventsIcebergTableName: "initial_events_iceberg",
      eventsIcebergTableName: "events_iceberg",
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      icebergInitFunctionName: icebergInitFn.name, // Export new function name
      routerDistributionId: router.distributionID, // Export router ID
    }
  },
});
