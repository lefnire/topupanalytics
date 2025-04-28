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

    // Create table for initial events (contains all session data) - Original Glue Table
    const initialEventsGlueTable = new aws.glue.CatalogTable(`InitialEventsGlueTable`, {
      name: `initial_events`,
      databaseName: glueCatalogDatabase.name,
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
        serDeInfo: {
          name: "parquet-serde",
          serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
          parameters: {"serialization.format": "1"}
        },
        columns: initialGlueColumns, compressed: false, storedAsSubDirectories: true,
      },
      partitionKeys: commonPartitionKeys,
    });

    // Create table for regular events (contains minimal data) - Original Glue Table
    const eventsGlueTable = new aws.glue.CatalogTable(`EventsGlueTable`, {
      name: `events`,
      databaseName: glueCatalogDatabase.name,
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
        serDeInfo: {
          name: "parquet-serde",
          serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
          parameters: {"serialization.format": "1"}
        },
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
      handler: "functions/iceberg-init.handler", // Correct handler path
      timeout: "10 minutes", // Keep increased timeout
      memory: "256 MB",
      architecture: "arm64",
      link: [
        glueCatalogDatabase,
        initialEventsGlueTable, // Link source table
        eventsGlueTable,       // Link source table
        eventsBucket,
        athenaResultsBucket
      ],
      environment: { // Pass values needed by the handler
        // Values from linked resources:
        GLUE_DATABASE_NAME: glueCatalogDatabase.name,
        SOURCE_INITIAL_EVENTS_TABLE_NAME: initialEventsGlueTable.name,
        SOURCE_EVENTS_TABLE_NAME: eventsGlueTable.name,
        EVENTS_BUCKET_NAME: eventsBucket.name,
        QUERY_RESULTS_BUCKET_NAME: athenaResultsBucket.name,
        // Values passed via invocation are handled by the Invocation resource below
        // INITIAL_EVENTS_ICEBERG_TABLE_NAME: "initial_events_iceberg",
        // EVENTS_ICEBERG_TABLE_NAME: "events_iceberg",
        // ATHENA_WORKGROUP: "primary",
      },
      permissions: [
        {
          actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"],
          resources: ["*"]
        }, // Specific Athena actions
        {
          actions: [
            "glue:GetTable",      // Needed to read source schema
            "glue:CreateTable",   // Needed to create temp table and Iceberg table
            "glue:GetDatabase"
          ],
          resources: [ // Specific Glue actions
            glueCatalogDatabase.arn,
            initialEventsGlueTable.arn, // Allow GetTable on source
            eventsGlueTable.arn,        // Allow GetTable on source
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`,
            $interpolate`arn:aws:glue:${region}:${accountId}:database/${glueCatalogDatabase.name}`,
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/*`, // Allow Create/Get on any table in the DB
          ]
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"], resources: [ // S3 permissions for Athena/Iceberg
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`,
            athenaResultsBucket.arn,
            $interpolate`${athenaResultsBucket.arn}/*`
          ]
        },
      ],
      nodejs: {
        install: ["@aws-sdk/client-athena", "@aws-sdk/client-glue"], // Glue client still needed for GetTable
      }
    });

    // === Invoke Iceberg Initialization Function ===
    // Only pass data not available via linked resources/env vars as input
    const icebergInitInput = {
      INITIAL_EVENTS_ICEBERG_TABLE_NAME: "initial_events_iceberg",
      EVENTS_ICEBERG_TABLE_NAME: "events_iceberg",
      ATHENA_WORKGROUP: "primary",
    };

    new aws.lambda.Invocation(`IcebergTableInitInvocation`, {
        functionName: icebergInitFn.name,
        input: $util.jsonStringify(icebergInitInput),
        triggers: {
          redeployment: Date.now().toString(),
        },
      }, {dependsOn: [icebergInitFn, initialEventsGlueTable, eventsGlueTable]}
    );

    // === IAM Role for Firehose ===
    const firehoseDeliveryRole = new aws.iam.Role(`FirehoseDeliveryRole`, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // === Firehose Processor Function (DELETED in Phase 3.1) ===
    // const firehoseProcessorFn = new sst.aws.Function("FirehoseProcessorFn", { ... });

    // Allow Firehose to write to S3 and access Glue
    new aws.iam.RolePolicy(`FirehoseDeliveryPolicy`, {
      role: firehoseDeliveryRole.id,
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          { "Effect": "Allow", "Action": ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], "Resource": ["${eventsBucket.arn}", "${eventsBucket.arn}/*"] },
          { "Effect": "Allow", "Action": ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"], "Resource": ["${glueCatalogDatabase.arn}", "${eventsGlueTable.arn}", "${initialEventsGlueTable.arn}", "arn:aws:glue:${region}:${accountId}:catalog"] },
          { "Effect": "Allow", "Action": [ "logs:PutLogEvents" ], "Resource": "arn:aws:logs:*:*:log-group:/aws/kinesisfirehose/*:*" }
        ]
      }`,
    });

    // === Kinesis Data Firehose Delivery Streams ===
    const eventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`EventsFirehoseStream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseDeliveryRole.arn, bucketArn: eventsBucket.arn,
        prefix: "events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/", // Phase 3.1: Use partitionKeyFromQuery
        errorOutputPrefix: "errors/events/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/", // Removed dynamic partition key
        bufferingInterval: 60, bufferingSize: 64, // compressionFormat: "UNCOMPRESSED", // Removed - Handled by Parquet SerDe
        processingConfiguration: { // Replace processors array
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                {
                  parameterName: "JsonParsingEngine",
                  parameterValue: "JQ-1.6",
                },
                {
                  parameterName: "MetadataExtractionQuery",
                  parameterValue: "{site_id:.site_id}", // Extract site_id
                },
              ],
            },
            {
              type: "AppendDelimiterToRecord",
              parameters: [
                {parameterName: "Delimiter", parameterValue: "\\n"}, // Note double backslash for newline in string
              ],
            },
          ],
        },
        dynamicPartitioningConfiguration: {enabled: true}, // Phase 3.1: Enable dynamic partitioning
        dataFormatConversionConfiguration: {
          enabled: true, inputFormatConfiguration: {deserializer: {openXJsonSerDe: {}}},
          outputFormatConfiguration: {serializer: {parquetSerDe: {compression: "SNAPPY"}}},
          schemaConfiguration: {
            databaseName: glueCatalogDatabase.name,
            tableName: eventsGlueTable.name,
            roleArn: firehoseDeliveryRole.arn
          },
        },
      },
    });

    const initialEventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`InitialEventsFirehoseStream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseDeliveryRole.arn, bucketArn: eventsBucket.arn,
        prefix: "initial_events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/", // Phase 3.1: Use partitionKeyFromQuery
        errorOutputPrefix: "errors/initial_events/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/", // Removed dynamic partition key
        bufferingInterval: 60, bufferingSize: 64, // compressionFormat: "UNCOMPRESSED", // Removed - Handled by Parquet SerDe
        processingConfiguration: { // Replace processors array
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                {
                  parameterName: "JsonParsingEngine",
                  parameterValue: "JQ-1.6",
                },
                {
                  parameterName: "MetadataExtractionQuery",
                  parameterValue: "{site_id:.site_id}", // Extract site_id
                },
              ],
            },
            {
              type: "AppendDelimiterToRecord",
              parameters: [
                {parameterName: "Delimiter", parameterValue: "\\n"}, // Note double backslash for newline in string
              ],
            },
          ],
        },
        dynamicPartitioningConfiguration: {enabled: true}, // Phase 3.1: Enable dynamic partitioning
        dataFormatConversionConfiguration: {
          enabled: true, inputFormatConfiguration: {deserializer: {openXJsonSerDe: {}}},
          outputFormatConfiguration: {serializer: {parquetSerDe: {compression: "SNAPPY"}}},
          schemaConfiguration: {
            databaseName: glueCatalogDatabase.name,
            tableName: initialEventsGlueTable.name,
            roleArn: firehoseDeliveryRole.arn
          },
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
        userPreferencesTable
      ],
      environment: { // Only pass values not available via linked resources
        ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // String constant
        ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // String constant
        USE_STRIPE: useStripe.toString(), // Step 7: Add USE_STRIPE
      },
      permissions: [
        {actions: ["athena:*"], resources: ["*"]},
        { // Add Glue permissions for Athena metadata access
          actions: [
            "glue:GetDatabase",
            "glue:GetTable",
            "glue:GetPartitions" // Add GetPartitions, often needed by Athena for partitioned tables
          ],
          resources: [
            glueCatalogDatabase.arn, // Grant on specific DB ARN
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Keep catalog ARN
            $interpolate`arn:aws:glue:${region}:${accountId}:database/${glueCatalogDatabase.name}`, // Grant on DB name ARN pattern
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/*` // Grant on table wildcard ARN
          ]
        },
        // {actions: ["s3:ListBucket"], resources: [athenaResultsBucket.arn, eventsBucket.arn]}, // Corrected bucket variable name if uncommented
        // Permission to query sitesTable needed to scope results
        // {actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`]},
        // Permission to get user preferences
        // {actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn]},
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

    // === Compaction Function & Cron ===
    const compactionFn = new sst.aws.Function("CompactionFn", {
      handler: "functions/analytics/compact.handler",
      timeout: "15 minutes", memory: "512 MB", architecture: "arm64",
      link: [
        glueCatalogDatabase,
        eventsBucket,
        athenaResultsBucket
      ],
      environment: { // Only pass values not available via linked resources
        ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // String constant
        ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // String constant
      },
      permissions: [
        {
          actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"],
          resources: ["*"]
        }, // Specific Athena actions for OPTIMIZE/CTAS
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads", "s3:AbortMultipartUpload"],
          resources: [ // Broad S3 access needed for compaction/manifests
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`,
            athenaResultsBucket.arn, // Access results bucket too
            $interpolate`${athenaResultsBucket.arn}/*`
          ]
        },
        {
          actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions", "glue:UpdateTable", "glue:UpdatePartition", "glue:BatchUpdatePartition"],
          resources: [ // Glue Read/Update for compaction metadata
            glueCatalogDatabase.arn, // Database ARN from link
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Catalog access
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${glueCatalogDatabase.name}/*`, // Access to manage tables within the DB (incl. Iceberg)
            initialEventsGlueTable.arn, // Grant access to original tables too if needed
            eventsGlueTable.arn,
          ]
        },
      ],
    });

    // Phase 4.C: Add Cron job for compaction
    new sst.aws.Cron("CompactionCron", {
      schedule: "cron(5 * * * ? *)", // Hourly at 5 past the hour
      function: compactionFn.arn // Use the ARN of the existing compactionFn
    });

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
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: eventsFirehoseStream.name,
      initialEventsFirehoseStreamName: initialEventsFirehoseStream.name,
      glueDatabaseName: glueCatalogDatabase.name,
      eventsTableName: eventsGlueTable.name,
      initialEventsTableName: initialEventsGlueTable.name,
      initialEventsIcebergTableName: "initial_events_iceberg",
      eventsIcebergTableName: "events_iceberg",
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      icebergInitFunctionName: icebergInitFn.name, // Export new function name
      routerDistributionId: router.distributionID, // Export router ID
      chargeProcessorFunctionName: chargeProcessorFn?.name, // Conditionally export name
      // Ensure other Stripe-related outputs are handled if needed, though none were explicitly defined before
      // Conditionally export real secret names/ARNs if needed, otherwise omit or use placeholders
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined, // Example
    }
  },
});
