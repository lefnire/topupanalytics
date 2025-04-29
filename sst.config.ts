/// <reference path="./.sst/platform/config.d.ts" />

/*
## Instructions
This uses SST v3, which uses Pulumi under the hood - not CDK (SST v2). SST v3 adds a global variable `aws`, which is an augmented version of the `aws` you'd import from Pulumi. Never try to add imports to this file, always use the global `aws`, and assume it has what you'd need from Pulumi. If you need `aws-native` or other providers, assume those are global variables too and add a note to me to add that provider. SST also adds global `$` functions for Pulumi helpers, like `$interpolate`. Use those instead of Pulumi helpers.

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
    const region = aws.getRegionOutput({}).name
    const partition = aws.getPartitionOutput({}).partition // Needed for ARN construction
    // Define basename early and use consistently for resource naming
    const basename = `${$app.name}${$app.stage}`;

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
      properties: {name: table.name, arn: table.arn, databasename: table.databaseName},
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions", "glue:GetPartition", "glue:GetPartitions"], // Read actions
          resources: [
            table.arn,
            // Use $interpolate for constructing related ARNs
            $interpolate`arn:${partition}:glue:${region}:${accountId}:database/${table.databaseName}`,
            $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
           ],
        }),
      ],
    }));

    const tableNames = ['events', 'initial_events'] as const;
    type TableName = typeof tableNames[number]; // Define a type for table names

    // === S3 Bucket for Analytics Data ===
    const analyticsDataBucket = new sst.aws.Bucket("AnalyticsDataBucket", {
      // name: `${basename}-analytics-data`, // Explicit name if needed, SST generates one
      // intelligentTiering: true, // ERROR: Not a valid property here. Apply lifecycle rule below.
    });

    // === Secrets === Step 2: Use undefined for non-Stripe case
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined; // For frontend


    // === S3 Buckets ===
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {
        // name: `${basename}-athena-results`, // Use explicit, stage-specific name
    });

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

    // Apply lifecycle rule to Analytics Data Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`AnalyticsDataBucketLifecycle`, {
      bucket: analyticsDataBucket.name,
      rules: intelligentTieringRule, // Use the defined rule
    });

    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`AthenaResultsBucketLifecycle`, {
      bucket: athenaResultsBucket.name, // Reference the explicit name
      rules: intelligentTieringRule,
    });

    // === Glue Data Catalog ===
    const glueCatalogDatabase = new aws.glue.CatalogDatabase(`GlueCatalogDatabase`, {
      name: `${basename}_db`, // Use explicit name, underscores only
      // Point location to a logical path within the S3 Table Bucket for organization
      // locationUri is not typically needed for Glue DB, especially with Iceberg tables managing their own locations.
    });

    // Import schemas for both tables
    const {initialGlueColumns, eventsGlueColumns} = await import('./functions/analytics/schema');
    const glueColumns: Record<TableName, aws.types.input.glue.CatalogTableStorageDescriptorColumn[]> = { // Added type hint
        events: eventsGlueColumns,
        initial_events: initialGlueColumns
    };

    // Define partition keys once for consistency
    const commonPartitionKeys: aws.types.input.glue.CatalogTablePartitionKey[] = [ // Added type hint
      {name: "site_id", type: "string"},
      {name: "dt", type: "string"}, // Format like yyyy-MM-dd
    ];

    // Create Glue Tables - Firehose Iceberg destination requires these
    const glueTables = Object.fromEntries(tableNames.map(tableName => {
        const glueTableName = `${basename}_${tableName}`; // Match S3 Table name convention
        return [
            tableName, // Keep original key for mapping
            new aws.glue.CatalogTable(`GlueCatalogTable${tableName}`, {
                name: glueTableName, // Use explicit name
                databaseName: glueCatalogDatabase.name,
                tableType: "EXTERNAL_TABLE", // Required for Iceberg format
                parameters: { // Parameters specific to Iceberg
                  "table_type": "ICEBERG", // Identify as Iceberg
                  "classification": "iceberg", // Can also be parquet if Firehose converts first
                  // "lakeformation.governed": "true", // *** VITAL: Indicate LF governance
                  // Add other relevant parameters if needed
                  // "write.parquet.compression-codec": "snappy", // Example: Set Parquet compression if needed (Firehose handles it here)
                },
                storageDescriptor: {
                    // Location points to the *base* path for the table in the new S3 bucket
                    location: $interpolate`s3://${analyticsDataBucket.name}/${tableName}/`, // Base path for the table
                    columns: glueColumns[tableName], // Schema from import
                    // SerDe, InputFormat, OutputFormat are generally NOT needed for Glue Iceberg tables
                    // Glue uses the Iceberg metadata layer.
                    compressed: false, // Compression handled by Parquet/Iceberg writers
                    storedAsSubDirectories: false, // Iceberg manages its own directory structure
                },
                partitionKeys: commonPartitionKeys, // Define partition keys directly on the table
                openTableFormatInput: { // Define Iceberg specific input
                    icebergInput: {
                        metadataOperation: "CREATE", // Create the table metadata
                        version: "2", // Specify Iceberg format version (optional, defaults usually ok)
                    }
                }
            })
        ];
    })) as Record<TableName, aws.glue.CatalogTable>; // Type assertion

    // === IAM Role for Firehose ===
    const firehoseDeliveryRole = new aws.iam.Role(`FirehoseDeliveryRole`, {
      name: `${basename}-firehose-delivery-role`, // Use explicit, stage-specific name
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // Allow Firehose to write to S3 and access Glue (Updated for Iceberg)
    new aws.iam.RolePolicy(`FirehoseDeliveryPolicy`, {
      role: firehoseDeliveryRole.id, // Reference the role's ID output
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation",
              "s3:GetObject",
              "s3:ListBucket",
              "s3:ListBucketMultipartUploads",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:GetBucketAcl",
              "s3:GetObjectAcl",
              "s3:PutObjectAcl"
            ],
            "Resource": [
              "${analyticsDataBucket.arn}",
              "${analyticsDataBucket.arn}/*"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [
              "glue:GetDatabase",
              "glue:GetTable",
              "glue:GetTableVersion",
              "glue:GetTableVersions",
              "glue:GetPartitions",
              "glue:BatchCreatePartition",
              "glue:UpdateTable"
            ],
            "Resource": [
              "arn:${partition}:glue:${region}:${accountId}:catalog",
              "${glueCatalogDatabase.arn}",
              "${glueTables.events.arn}",
              "${glueTables.initial_events.arn}"
            ]
          },
          {
             "Effect": "Allow",
             "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
             ],
             "Resource": "arn:${partition}:logs:${region}:${accountId}:log-group:/aws/kinesisfirehose/${basename}-firehose-*:*"
          }
        ]
      }`,
    });

    // === Lake Formation Permissions REMOVED ===
    // Lake Formation is not required for this standard S3/Glue/Firehose setup.
    // Standard IAM permissions on the Firehose role are sufficient.

    // === Kinesis Data Firehose Delivery Streams ===
    // Configure destination: "extended_s3" with data format conversion and dynamic partitioning
    const firehoses = Object.fromEntries(tableNames.map(tableName => {
        const glueTable = glueTables[tableName]; // Get the specific Glue table resource
        return [
            tableName, // Keep original key for mapping
            new aws.kinesis.FirehoseDeliveryStream(`FirehoseStream${tableName}`, {
                name: `${basename}-firehose-${tableName}`, // Use explicit, stage-specific name
                destination: "extended_s3", // Use extended_s3 destination
                tags: {
                    Environment: $app.stage,
                    Project: $app.name,
                    Table: tableName,
                },
                // Buffering hints removed due to persistent TS errors
                extendedS3Configuration: {
                    roleArn: firehoseDeliveryRole.arn,
                    bucketArn: analyticsDataBucket.arn, // Use the new bucket ARN
                    bufferingInterval: 60,
                    bufferingSize: 64,
                    // Buffering hints removed from here
                    // Data Format Conversion: JSON -> Parquet using Glue schema
                    dataFormatConversionConfiguration: {
                        enabled: true,
                        inputFormatConfiguration: {
                            deserializer: { openXJsonSerDe: {} } // Input is JSON
                        },
                        outputFormatConfiguration: {
                            serializer: { parquetSerDe: {} } // Output is Parquet
                        },
                        schemaConfiguration: {
                            databaseName: glueCatalogDatabase.name,
                            tableName: glueTable.name,
                            roleArn: firehoseDeliveryRole.arn, // Role needs access to Glue schema
                        }
                    },
                    // Dynamic Partitioning based on site_id and dt from JSON payload
                    dynamicPartitioningConfiguration: {
                        enabled: true,
                        // retryOptions removed due to persistent TS errors
                    },
                    // Retry options removed from here
                    // S3 Prefix using dynamic partitioning keys (Hive-style)
                    prefix: $interpolate`${tableName}/site_id=!{partitionKeyFromQuery:site_id}/dt=!{partitionKeyFromQuery:dt}/`,
                    // Error output prefix
                    errorOutputPrefix: $interpolate`firehose-errors/${tableName}/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/`,
                    // CloudWatch logging (optional but recommended)
                    cloudwatchLoggingOptions: {
                       enabled: true,
                       logGroupName: $interpolate`/aws/kinesisfirehose/${basename}-firehose-${tableName}`, // Match name pattern
                       logStreamName: "S3Delivery",
                    },
                    // JQ Processing for extracting partition keys
                    // This configuration enables Firehose to extract 'site_id' and 'dt'
                    // from the incoming JSON records using JQ, making them available
                    // for dynamic partitioning via !{partitionKeyFromQuery:...} in the prefix.
                    processingConfiguration: {
                        enabled: true,
                        processors: [{
                            type: "MetadataExtraction",
                            parameters: [
                                // JQ query to extract the required fields for partitioning
                                { parameterName: "MetadataExtractionQuery", parameterValue: "{site_id:.site_id, dt:.dt}" },
                                // Specify the JSON parsing engine
                                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" }
                            ]
                        }]
                    }
                },
                // Retry options removed from top level
            })
        ];
    })) as Record<TableName, aws.kinesis.FirehoseDeliveryStream>; // Type assertion


    // === Cognito User Pool (Using SST Component) ===
    const userPool = new sst.aws.CognitoUserPool("UserPool", {
      usernames: ["email"],
      transform: {
        userPool: (args) => {
          args.name = `${basename}-user-pool`; // Explicit name
          args.passwordPolicy = {
            minimumLength: 7,
            requireLowercase: false,
            requireNumbers: false,
            requireSymbols: false,
            requireUppercase: false,
            temporaryPasswordValidityDays: 7,
          };
          args.accountRecoverySetting = { // Add recovery setting
             recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
          };
        },
      }
    });
    const userPoolClientSst = userPool.addClient("UserPoolClient", {
       // name: `${basename}-web-client`, // Explicit name
       // transform can be used here if needed for specific client settings
       // transform: { client: (args) => { ... }}
    });

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      // name: `${basename}-sites`, // Explicit name
      fields: {
        site_id: "string",
        owner_sub: "string",
        plan: "string",
      },
      primaryIndex: {hashKey: "site_id"},
      globalIndexes: {
        ownerSubIndex: {hashKey: "owner_sub", projection: ["site_id"]},
        planIndex: {hashKey: "plan", projection: "all"},
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      // name: `${basename}-user-preferences`, // Explicit name
      fields: {
        cognito_sub: "string",
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
      architecture: "arm64", // Use ARM
      // Keep URL enabled, but primary access is via Router route below
      url: {
        cors: true,
        // authorizer: "none"
      },
      link: [
        firehoses.events,
        firehoses.initial_events,
        sitesTable,
        userPreferencesTable // Link the user preferences table
      ],
      environment: { // Step 7: Add USE_STRIPE
        USE_STRIPE: useStripe.toString(),
        // Resource properties (names, ARNs) are available via Resource.* in function code
      },
      permissions: [
        // Permissions for linked resources (Firehose, DynamoDB) are handled by linking
      ],
    });
    router.route("/api/event", ingestFn.url);


    const queryFn = new sst.aws.Function("QueryFn", {
      handler: "functions/analytics/query.handler",
      timeout: "60 second",
      memory: "512 MB",
      architecture: "arm64", // Use ARM
      // NOTE: queryFn is NOT attached to the public Router
      link: [
        glueCatalogDatabase,        // Link DB
        glueTables.events,          // Link events Glue Table
        glueTables.initial_events,  // Link initial_events Glue Table
        athenaResultsBucket,        // Link results bucket
        analyticsDataBucket,        // Link the data bucket
        sitesTable,
        userPreferencesTable,
      ],
      environment: {
        // Resource properties (names, ARNs) are available via Resource.* in function code
        USE_STRIPE: useStripe.toString(),
      },
      permissions: [
        // Athena execution permissions (cannot be fully handled by linking specific resources)
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"], resources: ["*"] },
        // Glue permissions are handled by linking Glue DB/Tables
        // S3 permissions for Athena results bucket (Keep explicit as linking might not cover all Athena/S3 nuances)
        { actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:DeleteObject"], resources: [athenaResultsBucket.arn, `${athenaResultsBucket.arn}/*`] },
        // S3 permissions for reading analytics data are handled by linking analyticsDataBucket
        // DynamoDB permissions are handled by linking sitesTable and userPreferencesTable
      ],
    });


    // === Management API Functions ===
    const sitesFn = new sst.aws.Function("SitesFn", {
      handler: "functions/api/sites.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64", // Use ARM
      link: [sitesTable, router], // Link router to get URL
      environment: {
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
      architecture: "arm64", // Use ARM
      link: [userPreferencesTable], // Link preferences table
      permissions: [
        // Permissions for linked resources (DynamoDB) are handled by linking
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        // Resource properties (names, ARNs) are available via Resource.* in function code
      },
    });

    // Step 3: Conditional stripeFn
    let stripeFn: sst.aws.Function | undefined;
    if (useStripe) {
      stripeFn = new sst.aws.Function("StripeFn", {
        handler: "functions/api/stripe.handler",
        timeout: "10 second",
        memory: "128 MB",
        architecture: "arm64", // Use ARM
        link: [
          STRIPE_SECRET_KEY!, // Use non-null assertion as we are inside the if block
          STRIPE_WEBHOOK_SECRET!, // Use non-null assertion
          userPreferencesTable, // Link for customer ID lookup/storage
          sitesTable,           // Link for subscription ID/plan update
        ],
       environment: {
         USE_STRIPE: useStripe.toString(),
         // Resource properties (names, ARNs) are available via Resource.* in function code
       },
       permissions: [
         // Permissions for linked resources (DynamoDB) are handled by linking
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
      } : undefined,
      cors: { // CORS needed for dashboard interaction
        allowOrigins: isProd ? [`https://${domain}`] : ["http://localhost:5173", "http://127.0.0.1:5173"], // Adjust port if needed
        allowCredentials: true, // Allow credentials (needed for JWT)
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

    // Define common auth config once
    const commonAuth = {auth: {jwt: {authorizer: jwtAuthorizer.id}}};

    // === Management API Routes (Using Function ARNs for explicit definition) ===

    // Use object syntax for route definition for clarity
    api.route("GET /api/query", queryFn.arn, commonAuth);
    api.route("POST /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("PUT /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("DELETE /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}/script", sitesFn.arn, commonAuth);
    api.route("GET /api/user/preferences", preferencesFn.arn, commonAuth);
    api.route("PUT /api/user/preferences", preferencesFn.arn, commonAuth);

    // Step 5: Conditional Stripe API Routes
    if (useStripe && stripeFn) { // Check stripeFn exists
      api.route("POST /api/stripe/webhook", stripeFn.arn); // NO auth needed
      api.route("POST /api/stripe/checkout", stripeFn.arn, commonAuth); // Requires JWT auth
      api.route("GET /api/stripe/portal", stripeFn.arn, commonAuth); // Add portal route
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
        VITE_APP_URL: router.url, // App URL is the router URL
        VITE_STRIPE_PUBLISHABLE_KEY: useStripe ? STRIPE_PUBLISHABLE_KEY!.value : DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER, // Correct: Use real value or placeholder string
        VITE_USE_STRIPE: useStripe.toString(), // Add the flag
        VITE_PUBLIC_INGEST_URL: publicIngestUrl, // Ensure this still exists and uses the variable
      },
       // dev: { // Add dev config
       //    deploy: true, // Deploy frontend during dev
       //    // url: "http://localhost:5173" // Optional: if your local dev server URL is different
       // }
    });

    // === Compaction Function & Cron (REMOVED - Iceberg handles auto-compaction) ===
    // Iceberg handles compaction. Manual OPTIMIZE via Athena might be needed occasionally if auto-compaction isn't sufficient.

    // Step 4: Conditional chargeProcessorFn and Cron
    let chargeProcessorFn: sst.aws.Function | undefined;
    if (useStripe) {
      chargeProcessorFn = new sst.aws.Function("ChargeProcessorFn", {
        handler: "functions/billing/chargeProcessor.handler",
        timeout: "60 second", // Allow time for Stripe API calls and DB updates
        memory: "256 MB",
        architecture: "arm64", // Use ARM
        link: [
          sitesTable,
          userPreferencesTable,
          STRIPE_SECRET_KEY!, // Correct: Use non-null assertion
        ],
       environment: {
         USE_STRIPE: useStripe.toString(),
         // Resource properties (names, ARNs) are available via Resource.* in function code
       },
       permissions: [
         // Permissions for linked resources (DynamoDB) are handled by linking
       ],
        nodejs: {
          install: ["stripe", "@aws-sdk/client-dynamodb"], // Add necessary SDKs
        }
      });

      new sst.aws.Cron("ChargeCron", {
        schedule: "rate(5 minutes)", // Adjust schedule as needed
        function: chargeProcessorFn.arn // Trigger the charge processor function ARN
      });
    }

    // === Outputs ===
    return {
      appName: $app.name,
      stage: $app.stage, // Add stage output
      accountId: accountId,
      region: region, // Add region output
      dashboardUrl: router.url, // Use router URL for dashboard access
      managementApiUrl: api.url, // Rename output for clarity
      publicIngestUrl: publicIngestUrl, // Construct ingest URL from router
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      dataBucketName: analyticsDataBucket.name,
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: firehoses.events.name,
      initialEventsFirehoseStreamName: firehoses.initial_events.name,
      glueDatabaseName: glueCatalogDatabase.name, // Corrected output key name
      eventsGlueTableName: glueTables.events.name,
      initialEventsGlueTableName: glueTables.initial_events.name,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      routerDistributionId: router.distributionID, // Export router ID
      chargeProcessorFunctionName: chargeProcessorFn?.name, // Conditionally export name
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined,
      // Add other function names if useful
      sitesFunctionName: sitesFn?.name,
      preferencesFunctionName: preferencesFn?.name,
      stripeFunctionName: stripeFn?.name,
    }
  },
});