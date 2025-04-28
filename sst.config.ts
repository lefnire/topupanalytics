/// <reference path="./.sst/platform/config.d.ts" />

/*
## Data Pipeline: Cost-Optimized & Scalable Analytics

The primary goal of this data pipeline is extreme cost-effectiveness and scalability, aiming to support a high volume of events and queries affordably. The core AWS services used are Kinesis Firehose, S3, Glue, Athena, Lambda, CloudFront (via SST Router), and API Gateway V2.

## Next Steps / Missing Components

Core components implemented. See 'Potential Architectural Improvements' below for further enhancements.

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
    const useStripe = process.env.USE_STRIPE === 'true'; // Step 1: Read env var
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId
    const region = aws.getRegionOutput().name
    const baseName = `${$app.name}${$app.stage}`; // Define baseName early

    // Placeholder values instead of sst.Secret.create
    const DUMMY_STRIPE_SECRET_KEY_PLACEHOLDER = "dummy_stripe_secret_key_placeholder";
    const DUMMY_STRIPE_WEBHOOK_SECRET_PLACEHOLDER = "dummy_stripe_webhook_secret_placeholder";
    const DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER = "dummy_stripe_publishable_key_placeholder";


    // === Linkable Wrappers (using global sst) ===
    // Wrap Kinesis Firehose Delivery Stream
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: {name: stream.name},
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [stream.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Database
    sst.Linkable.wrap(aws.glue.CatalogDatabase, (db) => ({
      properties: {name: db.name, arn: db.arn},
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetDatabase"],
          resources: [db.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Table
    sst.Linkable.wrap(aws.glue.CatalogTable, (table) => ({
      properties: {name: table.name, arn: table.arn, databaseName: table.databaseName},
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions", "glue:GetPartition", "glue:GetPartitions"], // Read actions
          resources: [table.arn, $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, $interpolate`arn:aws:glue:${region}:${accountId}:database/${table.databaseName}`], // Include DB ARN
        }),
      ],
    }));

    // === Configuration ===
    // const baseName = `${$app.name}-${$app.stage}`; // Moved up

    // === Secrets === Step 2: Use undefined for non-Stripe case
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined; // For frontend


    // === S3 Buckets ===
    const eventsBucket = new sst.aws.Bucket("EventData", {});
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {});

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
    new aws.s3.BucketLifecycleConfigurationV2(`EventDataBucketLifecycle`, {
      bucket: eventsBucket.name,
      rules: intelligentTieringRule,
    });

    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`AthenaResultsBucketLifecycle`, {
      bucket: athenaResultsBucket.name,
      rules: intelligentTieringRule,
    });

    // === Glue Data Catalog ===
    const glueCatalogDatabase = new aws.glue.CatalogDatabase(`GlueCatalogDatabase`, {
      name: `${baseName}_analytics_db`, // Glue names often use underscores
      // Add a default location for managed tables like Iceberg
      locationUri: $interpolate`s3://${eventsBucket.name}/_glue_database/`,
    });

    // Import schemas for both tables
    const {initialGlueColumns, eventsGlueColumns} = await import('./functions/analytics/schema');

    // Define partition keys once for consistency
    const commonPartitionKeys = [
      {name: "site_id", type: "string"},
      {name: "dt", type: "string"},
    ];

    // === Iceberg Table Names (Managed by Init Lambda) ===
    // These names must match the ones used in the IcebergInitFn and the invocation payload.
    const initialEventsIcebergTableName = `initial_events_managed_iceberg`;
    const eventsIcebergTableName = `events_managed_iceberg`;

    // === Iceberg Table Initialization Function ===
    const icebergInitFn = new sst.aws.Function("IcebergInitFn", {
      handler: "functions/iceberg-init.handler",
      timeout: "5 minute", // Allow ample time for Athena DDL and polling
      memory: "256 MB",
      architecture: "arm64",
      link: [
        glueCatalogDatabase,
        eventsBucket,
        athenaResultsBucket,
      ],
      environment: {
        GLUE_DATABASE_NAME: glueCatalogDatabase.name,
        EVENTS_BUCKET_NAME: eventsBucket.name,
        QUERY_RESULTS_BUCKET_NAME: athenaResultsBucket.name,
      },
      permissions: [
        // Athena permissions to run DDL
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution"], resources: ["*"] }, // Scoped down if specific workgroup ARN is known/needed
        // Glue permissions to check/delete/create tables
        { actions: ["glue:GetDatabase"], resources: [glueCatalogDatabase.arn] },
        // Grant table actions on both the database and the table pattern within that database
        {
          actions: ["glue:GetTable", "glue:DeleteTable", "glue:CreateTable"],
          resources: [
            glueCatalogDatabase.arn, // Grant on the database itself
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/*`, // Grant on tables within the database
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog` // Also grant on the catalog for DeleteTable/CreateTable
          ]
        },
        // The GetTable permission on the catalog is now covered above, removing redundant statement.
        // S3 permissions for Athena results and table locations
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], resources: [$interpolate`${athenaResultsBucket.arn}/iceberg-init-ddl/*`] },
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"], resources: [eventsBucket.arn, $interpolate`${eventsBucket.arn}/*`] }, // For table data/metadata
      ],
      nodejs: {
        install: [
          "@aws-sdk/client-athena",
          "@aws-sdk/client-glue",
        ]
      }
    });

    // === Invoke Iceberg Initialization Function ===
    const icebergInitInvocation = new aws.lambda.Invocation("IcebergTableInitInvocation", {
      functionName: icebergInitFn.name,
      triggers: { // Use triggers to ensure it runs on deployment/update
        redeployment: Date.now().toString(), // Force re-invocation on every deploy
      },
      // Payload should be a plain JS object, SST handles serialization
      input: $jsonStringify({ // Input needs to be JSON stringified
        INITIAL_EVENTS_ICEBERG_TABLE_NAME: initialEventsIcebergTableName,
        EVENTS_ICEBERG_TABLE_NAME: eventsIcebergTableName,
        ATHENA_WORKGROUP: "primary", // Assuming default workgroup, adjust if needed
      }),
      // dependsOn: [icebergInitFn, glueCatalogDatabase, eventsBucket, athenaResultsBucket], // Removed: dependsOn is not a direct arg here; dependencies are inferred or handled via triggers/inputs
    });


    // === IAM Role for Firehose ===
    const firehoseDeliveryRole = new aws.iam.Role(`FirehoseDeliveryRole`, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // === Firehose Processor Function (DELETED in Phase 3.1) ===
    // const firehoseProcessorFn = new sst.aws.Function("FirehoseProcessorFn", { ... });

    // Allow Firehose to write to S3 and access Glue
    new aws.iam.RolePolicy(`FirehoseDeliveryPolicy`, {
      role: firehoseDeliveryRole.id,
      // Use Pulumi's structured policy definition for better type safety and interpolation
      policy: $jsonStringify({ // Use SST's $jsonStringify
        Version: "2012-10-17",
        Statement: [
          { // S3 Permissions
            Effect: "Allow",
            Action: [
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation",
              "s3:GetObject",
              "s3:ListBucket",
              "s3:ListBucketMultipartUploads",
              "s3:PutObject"
            ],
            Resource: [eventsBucket.arn, $interpolate`${eventsBucket.arn}/*`], // Use SST's $interpolate
          },
          { // Glue Permissions (using resource names)
            Effect: "Allow",
            Action: [
              "glue:GetTable",
              "glue:GetTableVersion",
              "glue:GetTableVersions"
            ],
            Resource: [
              glueCatalogDatabase.arn,
              $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/${initialEventsIcebergTableName}`, // Use SST's $interpolate
              $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/${eventsIcebergTableName}`, // Use SST's $interpolate
              $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Use SST's $interpolate
            ],
          },
          { // CloudWatch Logs Permissions
            Effect: "Allow",
            Action: ["logs:PutLogEvents"],
            Resource: "arn:aws:logs:*:*:log-group:/aws/kinesisfirehose/*:*",
          },
        ],
      }),
    });

    // === Kinesis Data Firehose Delivery Streams ===
    const eventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`EventsFirehoseStream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseDeliveryRole.arn, bucketArn: eventsBucket.arn,
        prefix: "managed_iceberg/events/!{partitionKeyFromQuery:site_id}/!{timestamp:yyyy-MM-dd}/",
        errorOutputPrefix: "firehose-errors/events_managed_iceberg/!{firehose:error-output-type}/",
        bufferingInterval: 60, bufferingSize: 64,
        processingConfiguration: { // Keep metadata extraction and delimiter
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
                { parameterName: "MetadataExtractionQuery", parameterValue: "{site_id:.site_id}" },
              ],
            },
            {
              type: "AppendDelimiterToRecord",
              parameters: [{ parameterName: "Delimiter", parameterValue: "\\n" }],
            },
          ],
        },
        dynamicPartitioningConfiguration: { enabled: true }, // Keep dynamic partitioning enabled
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
          schemaConfiguration: {
            databaseName: glueCatalogDatabase.name,
            tableName: eventsIcebergTableName, // Use the defined variable name
            roleArn: firehoseDeliveryRole.arn,
          },
        },
        cloudwatchLoggingOptions: { // Add CloudWatch logging
            enabled: true,
            logGroupName: `/aws/kinesisfirehose/${baseName}-events-stream-managed`,
            logStreamName: "S3Delivery"
        },
      },
    });

    const initialEventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`InitialEventsFirehoseStream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseDeliveryRole.arn, bucketArn: eventsBucket.arn,
        prefix: "managed_iceberg/initial_events/!{partitionKeyFromQuery:site_id}/!{timestamp:yyyy-MM-dd}/",
        errorOutputPrefix: "firehose-errors/initial_events_managed_iceberg/!{firehose:error-output-type}/",
        bufferingInterval: 60, bufferingSize: 64,
        processingConfiguration: { // Keep metadata extraction and delimiter
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
                { parameterName: "MetadataExtractionQuery", parameterValue: "{site_id:.site_id}" },
              ],
            },
            {
              type: "AppendDelimiterToRecord",
              parameters: [{ parameterName: "Delimiter", parameterValue: "\\n" }],
            },
          ],
        },
        dynamicPartitioningConfiguration: { enabled: true }, // Keep dynamic partitioning enabled
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
          schemaConfiguration: {
            databaseName: glueCatalogDatabase.name,
            tableName: initialEventsIcebergTableName, // Use the defined variable name
            roleArn: firehoseDeliveryRole.arn,
          },
        },
        cloudwatchLoggingOptions: { // Add CloudWatch logging
            enabled: true,
            logGroupName: `/aws/kinesisfirehose/${baseName}-initial-events-stream-managed`,
            logStreamName: "S3Delivery"
        },
      },
    });

    // === Cognito User Pool (Using SST Component) ===
    const userPool = new sst.aws.CognitoUserPool("UserPool", {
      // name is handled by SST automatically
      usernames: ["email"], // Equivalent to usernameAttributes and autoVerifiedAttributes
      // passwordPolicy is managed by Cognito defaults or requires transform for customization
      transform: { // Add transform for user pool
        userPool: (args) => {
          args.passwordPolicy = {
            minimumLength: 6,
            requireLowercase: false,
            requireNumbers: false,
            requireSymbols: false,
            requireUppercase: false,
            temporaryPasswordValidityDays: 7,
          };
        },
      }
    });
    // Add the client using the addClient method
    const userPoolClientSst = userPool.addClient("UserPoolClient", {
      // generateSecret defaults to false in SST? Assuming yes.
      // explicitAuthFlows defaults? Assuming common flows like SRP/Refresh are allowed.
      // transform: { // Add transform for user pool client
      //   client: (args) => {
      //     args.explicitAuthFlows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"];
      //     // args.generateSecret = false; // Explicitly set if needed, though likely SST default
      //   },
      // }
    });

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      fields: {
        site_id: "string", // PK
        owner_sub: "string", // GSI PK
        plan: "string", // GSI PK for planIndex
        // Other fields like are still valid attributes but don't need to be listed here
        // unless they are part of a primary or secondary index key.
        // domains: "string", // JSON stringified list of allowed referer domains
        // // stripe_subscription_id: "string", // Removed - Replaced by payment method on user
        // request_allowance: "number", // Added - Usage-based billing allowance
        // allowed_fields: "string", // JSON stringified list of event fields allowed (for GDPR/filtering)
      },
      primaryIndex: {hashKey: "site_id"},
      globalIndexes: {
        // GSI for querying sites by owner
        ownerSubIndex: {hashKey: "owner_sub", projection: ["site_id"]},
        // GSI for querying sites needing payment
        planIndex: {hashKey: "plan", projection: "all"}, // NEW GSI
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      // Only define the primary key field here
      fields: {
        cognito_sub: "string", // PK
        // Other fields are still valid attributes but don't need to be listed here.
        // theme: "string",
        // email_notifications: "string",
        // stripe_customer_id: "string",
        // stripe_payment_method_id: "string",
        // stripe_last4: "string",
        // is_payment_active: "number",
      },
      primaryIndex: {hashKey: "cognito_sub"},
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
        cors: true,
        router: {
          instance: router,
          path: "/api/event", // Route /api/event via Router
          // method: "POST", // Method filtering happens in function or via Router config if available elsewhere
        }
      },
      link: [
        eventsFirehoseStream,
        initialEventsFirehoseStream,
        sitesTable,
        userPreferencesTable // Link the user preferences table
      ],
      environment: { // Step 7: Add USE_STRIPE
        USE_STRIPE: useStripe.toString(),
        // TODO use Resource.* to get these in ingest.ts
        EVENTS_FIREHOSE_STREAM_NAME: eventsFirehoseStream.name,
        INITIAL_EVENTS_FIREHOSE_STREAM_NAME: initialEventsFirehoseStream.name,
        SITES_TABLE_NAME: sitesTable.name,
        USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
      },
      permissions: [
        // Permission to query sitesTable is needed for validation
        {actions: ["dynamodb:GetItem"], resources: [sitesTable.arn]},
        // Permission to update request_allowance on sitesTable
        {actions: ["dynamodb:UpdateItem"], resources: [sitesTable.arn]},
        // Permission to get user preferences for payment status check
        {actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn]},
        // { actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`] } // Keep query if needed elsewhere? Revisit. GetItem is likely sufficient for site validation.
      ],
    });

    const queryFn = new sst.aws.Function("QueryFn", {
      handler: "functions/analytics/query.handler",
      timeout: "60 second",
      memory: "512 MB",
      // NOTE: queryFn is NOT attached to the public Router
      // It will be attached to the authenticated ApiGatewayV2 below
      link: [
        glueCatalogDatabase,
        athenaResultsBucket,
        eventsBucket,
        sitesTable,
        userPreferencesTable,
        // Link the Glue Database and Buckets. Specific table access is granted via IAM below.
        // Linking the tables directly isn't possible as they are created by the init Lambda.
      ],
      environment: {
        ATHENA_INITIAL_EVENTS_TABLE: initialEventsIcebergTableName, // Use the defined variable name
        ATHENA_EVENTS_TABLE: eventsIcebergTableName,               // Use the defined variable name
        USE_STRIPE: useStripe.toString(),
        GLUE_DATABASE_NAME: glueCatalogDatabase.name, // Keep these if needed by handler
        ATHENA_RESULTS_BUCKET: athenaResultsBucket.name, // Keep these if needed by handler
      },
      permissions: [
        { actions: ["athena:*"], resources: ["*"] },
        // Permissions for Glue/S3 should be handled by the linked resources
        // (glueCatalogDatabase, eventsBucket, athenaResultsBucket)
        // Add explicit permissions for the Lambda-created tables
        // Corrected Glue permissions for queryFn
        {
          effect: "allow", // Correct case for effect
          actions: ["glue:GetTable", "glue:GetPartitions"], // Corrected typo: Action -> actions
          resources: [ // Corrected typo: Resource -> resources
            glueCatalogDatabase.arn,
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/${initialEventsIcebergTableName}`, // Use SST's $interpolate
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/${eventsIcebergTableName}`, // Use SST's $interpolate
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Use SST's $interpolate
          ],
        },
        // Corrected S3 permissions for queryFn
        {
          effect: "allow", // Correct case for effect
          actions: ["s3:GetObject", "s3:ListBucket"], // Corrected typo: Action -> actions
          resources: [eventsBucket.arn, $interpolate`${eventsBucket.arn}/*`], // Corrected typo: Resource -> resources
        },
        // Keep explicit Athena permissions.
        // Keep permissions for sitesTable and userPreferencesTable if needed beyond linking (e.g., specific index queries not covered by default link)
      ],
    });


// === Management API Functions ===
    const sitesFn = new sst.aws.Function("SitesFn", {
      handler: "functions/api/sites.handler",
      timeout: "10 second",
      memory: "128 MB",
      link: [sitesTable], // Link sites table for CRUD
      permissions: [
        // Allow CRUD operations on sitesTable
        {
          actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          resources: [sitesTable.arn]
        },
        // Allow querying the owner index
        {actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`]},
      ],
      environment: {
        // PUBLIC_INGEST_URL is handled by route linking below // Keep comment for context
        ROUTER_URL: router.url, // Pass the base router URL
        USE_STRIPE: useStripe.toString(), // Step 7: Add USE_STRIPE
      },
      nodejs: {
        install: ["ulid"], // Add ulid dependency
      }
    });

    const preferencesFn = new sst.aws.Function("PreferencesFn", {
      handler: "functions/api/preferences.handler",
      timeout: "10 second",
      memory: "128 MB",
      link: [userPreferencesTable], // Link preferences table
      permissions: [
        // Allow CRUD operations on userPreferencesTable
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [userPreferencesTable.arn]
        },
      ],
      environment: { // Step 7: Add USE_STRIPE
        USE_STRIPE: useStripe.toString(),
      },
    });

    // Step 3: Conditional stripeFn
    let stripeFn: sst.aws.Function | undefined;
    if (useStripe) {
      stripeFn = new sst.aws.Function("StripeFn", {
        handler: "functions/api/stripe.handler",
        timeout: "10 second",
        memory: "128 MB",
        link: [
          STRIPE_SECRET_KEY!, // Use non-null assertion as we are inside the if block
          STRIPE_WEBHOOK_SECRET!, // Use non-null assertion
          userPreferencesTable, // Link for customer ID lookup/storage
          sitesTable,           // Link for subscription ID/plan update
        ],
        environment: { // Step 7: Add USE_STRIPE (conditionally)
          USE_STRIPE: useStripe.toString(),
        },
        permissions: [
          // Permissions to read/write stripe_customer_id in userPreferencesTable
          {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources: [userPreferencesTable.arn]},
          // Permissions to update stripe_subscription_id and plan in sitesTable
          {actions: ["dynamodb:UpdateItem"], resources: [sitesTable.arn]},
          // Note: Query permissions might be needed if searching by subscription ID, add later if required.
        ],
        nodejs: {
          install: ["stripe"], // Ensure stripe SDK is bundled if not already in root package.json
        }
      });
    }
    // === API Gateway (for Authenticated Endpoints like /api/query) ===
    const api = new sst.aws.ApiGatewayV2("ManagementApi", { // Renamed for clarity
      domain: isProd ? {
        name: `api.${domain}`, // Suggest using a subdomain like api.* for management endpoints
        // redirects property removed - not valid for ApiGatewayV2
      } : undefined,
      cors: { // CORS needed for dashboard interaction
        allowOrigins: isProd ? [`https://${domain}`] : ["*"], // Allow origin from the main dashboard domain or wildcard for dev
        allowCredentials: isProd ? true : false, // Set to false when allowOrigins is "*"
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allow necessary methods
        allowHeaders: ["Content-Type", "Authorization"], // Allow standard headers + Auth
      },
    });

    // Define JWT Authorizer (Using SST User Pool and Client)
    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClientSst.id], // Use the ID from the SST client object
      }
    });

    // Define Query Route on the Management API Gateway
    // Define common auth config once
    const commonAuth = {auth: {jwt: {authorizer: jwtAuthorizer.id}}};

    // === Management API Routes (Using Function ARNs) ===

    // --- Query Route ---
    // Pass the Function ARN as the handler (2nd arg), auth config as 3rd arg
    api.route("GET /api/query", queryFn.arn, commonAuth);

    // --- Sites Routes ---
    api.route("POST /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("PUT /api/sites/{site_id}", sitesFn.arn, commonAuth);
    // Note: Passing PUBLIC_INGEST_URL to the script endpoint via environment
    // isn't directly possible when using the ARN. If the handler needs this,
    // it might need to construct it or receive it differently.
    // For now, we assume the ARN linking is sufficient.
    // --- User Preferences Routes ---
    api.route("GET /api/user/preferences", preferencesFn.arn, commonAuth);
    api.route("PUT /api/user/preferences", preferencesFn.arn, commonAuth);

    // Step 5: Conditional Stripe API Routes
    if (useStripe && stripeFn) { // Check stripeFn exists
      api.route("POST /api/stripe/webhook", stripeFn.arn); // NO auth needed
      api.route("POST /api/stripe/checkout", stripeFn.arn, commonAuth); // Requires JWT auth
    }


    // === Dashboard (React Frontend) ===
    const publicIngestUrl = $interpolate`${router.url}/api/event`; // Define before component
    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      // Attach dashboard to the root of the public Router
      router: {
        instance: router,
        // path defaults to "/*" when attaching a site like this
      },
      // Link API Gateway for authenticated calls (/api/query)
      // Link UserPool/Client for frontend auth logic
      link: [
        api,
        userPool, // Link the SST UserPool component
        userPoolClientSst // Link the SST UserPoolClient object
      ],
      environment: { // Step 6: Conditional Dashboard Environment
        VITE_COGNITO_USER_POOL_ID: userPool.id, // Use ID from SST component
        VITE_COGNITO_CLIENT_ID: userPoolClientSst.id, // Use ID from SST client object
        VITE_AWS_REGION: region,
        VITE_API_URL: api.url,
        VITE_APP_URL: router.url,
        VITE_STRIPE_PUBLISHABLE_KEY: useStripe ? STRIPE_PUBLISHABLE_KEY!.value : DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER, // Correct: Use real value or placeholder string
        VITE_USE_STRIPE: useStripe.toString(), // Add the flag
        VITE_PUBLIC_INGEST_URL: publicIngestUrl, // Ensure this still exists and uses the variable
      },
    });

    // === Compaction Function & Cron (REMOVED) ===
    // The compactionFn Lambda is no longer needed as Glue manages Iceberg compaction.

    // The CompactionCron is no longer needed.

    // Step 4: Conditional chargeProcessorFn and Cron
    let chargeProcessorFn: sst.aws.Function | undefined;
    if (useStripe) {
      chargeProcessorFn = new sst.aws.Function("ChargeProcessorFn", {
        handler: "functions/billing/chargeProcessor.handler",
        timeout: "60 second", // Allow time for Stripe API calls and DB updates
        memory: "256 MB",
        architecture: "arm64",
        link: [
          sitesTable,
          userPreferencesTable,
          STRIPE_SECRET_KEY!, // Correct: Use non-null assertion
        ],
        environment: { // Step 7: Add USE_STRIPE (conditionally)
          USE_STRIPE: useStripe.toString(),
          // Inject placeholder value directly if Stripe is disabled and the function needs it
          // (Though these functions only run if useStripe is true, so linking the real secret is sufficient)
        },
        permissions: [
          // Query sites needing payment using the GSI
          {actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/planIndex`]},
          // Get user preferences to find payment details
          {actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn]},
          // Update site allowance/plan after successful charge
          {actions: ["dynamodb:UpdateItem"], resources: [sitesTable.arn]},
          // Update user payment status after failed charge
          {actions: ["dynamodb:UpdateItem"], resources: [userPreferencesTable.arn]},
        ],
        nodejs: {
          install: ["stripe", "@aws-sdk/client-dynamodb"], // Add necessary SDKs
        }
      });

      new sst.aws.Cron("ChargeCron", {
        schedule: "rate(5 minutes)",
        function: chargeProcessorFn.arn // Trigger the charge processor function
      });
    }

    // === Outputs ===
    return {
      appName: $app.name,
      accountId: accountId,
      // compactionFunctionName: compactionFn.name, // REMOVED
      // dashboardUrl: dashboard.url, // URL now comes from the router
      dashboardUrl: router.url, // Use router URL for dashboard access
      // apiUrl: api.url, // Keep API Gateway URL for management endpoints
      managementApiUrl: api.url, // Rename output for clarity
      // ingestFunctionUrl: ingestFn.url, // Ingest URL is via the router now
      publicIngestUrl: $interpolate`${router.url}/api/event`, // Construct ingest URL from router
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      dataBucketName: eventsBucket.name,
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: eventsFirehoseStream.name,
      initialEventsFirehoseStreamName: initialEventsFirehoseStream.name,
      glueDatabaseName: glueCatalogDatabase.name,
      eventsTableName: eventsIcebergTableName, // Use the defined variable name
      initialEventsTableName: initialEventsIcebergTableName, // Use the defined variable name
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      icebergInitFunctionName: icebergInitFn.name, // Add the init function name to outputs
      routerDistributionId: router.distributionID, // Export router ID
      chargeProcessorFunctionName: chargeProcessorFn?.name, // Conditionally export name
      // Ensure other Stripe-related outputs are handled if needed, though none were explicitly defined before
      // Conditionally export real secret names/ARNs if needed, otherwise omit or use placeholders
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined, // Example
    }
  },
});
