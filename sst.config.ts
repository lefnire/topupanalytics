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

    /*
     I added a aws.s3tables* Pulumi constructs. S3 Tables (with a capital T) is a new AWS
     Resource (Dec 2024) where you define an S3 Table Bucket (a brand new type of S3 Bucket);
     a Namespace (which contains multiple tables), and any number of tables. S3 Tables are
     automatically set to use Iceberg for the storage, they have compaction by default (though
     I may have to define those config params?), and snapshot management / expirty (so I
     don't think I even need intelligent tiering? I'm not sure). What I do know is that I no
     longer have to set up an Iceberg table, via an initialization script, nor a cron
     compaction function. S3 Tables are basically a construct that gets all the best-in-class
     of LakeFormation, Iceberg, compaction, Athena performance improvements, and more.
    */
    const tableNames = ['events', 'initial_events'] as const;
    type TableName = typeof tableNames[number]; // Define a type for table names

    // *** VITAL CHANGE: Use explicit bucket name (bucketId) based on basename ***
    const s3TableBucket = new aws.s3tables.TableBucket("S3TableBucket", {
        name: `${basename}-data`, // Use explicit, stage-specific name

    });

    // *** VITAL CHANGE: Use explicit namespace based on basename ***
    const s3TableNamespace = new aws.s3tables.Namespace("S3TableNamespace", {
        namespace: `${basename}_ns`, // Use explicit name, underscores only
        tableBucketArn: s3TableBucket.arn, // Reference the ARN
    });

    // S3 Table resources (represent the logical S3 Tables)
    // *** VITAL CHANGE: Use explicit table names based on basename ***
    const s3Tables = Object.fromEntries(tableNames.map(tableName => {
        const s3TableName = `${basename}_${tableName}`; // Glue/S3 Table name convention
        return [
            tableName, // Keep original key for mapping
            new aws.s3tables.Table(`S3Table${tableName}`, {
              name: s3TableName, // Use explicit name, underscores only
              namespace: s3TableNamespace.namespace,
              tableBucketArn: s3TableBucket.arn, // Reference ARN
              format: "ICEBERG",
              // Maintenance config can be added here if defaults aren't sufficient
              // maintenanceConfiguration: { ... }
            })
        ];
    })) as Record<TableName, aws.s3tables.Table>;
    /*
    metadataLocation: s3Tables['events'].metadataLocation,
    - undefined?
    warehouseLocation: s3Tables['events'].warehouseLocation
    - s3://96076612-1454-4a44-iqsfrnqtwwi8jasgxsj5i4wmikrneuse1b--table-s3
     */

    // === Secrets === Step 2: Use undefined for non-Stripe case
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined; // For frontend


    // === S3 Buckets ===
    // *** VITAL CHANGE: Use explicit bucket name based on basename ***
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {
        // name: `${basename}-athena-results`, // Use explicit, stage-specific name
    });

    // === Common S3 Lifecycle Rule for Intelligent Tiering ===
    // S3 Table Bucket lifecycle is managed differently. No rule needed for it.
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
    // new aws.s3.BucketLifecycleConfigurationV2(`EventDataBucketLifecycle`, {
    //   bucket: eventsBucket.name,
    //   rules: intelligentTieringRule,
    // });

    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`AthenaResultsBucketLifecycle`, {
      bucket: athenaResultsBucket.name, // Reference the explicit name
      rules: intelligentTieringRule,
    });

    // === Glue Data Catalog ===
    // *** VITAL CHANGE: Use explicit DB name based on basename ***
    const glueCatalogDatabase = new aws.glue.CatalogDatabase(`GlueCatalogDatabase`, {
      name: `${basename}_db`, // Use explicit name, underscores only
      // Point location to a logical path within the S3 Table Bucket for organization
      locationUri: $interpolate`s3://${s3TableBucket.id}/_glue_database/`, // Use bucketId (name) here
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
    // *** VITAL CHANGE: Use explicit table names, EXTERNAL_TABLE type, Iceberg params, location, openTableFormatInput ***
    const glueTables = Object.fromEntries(tableNames.map(tableName => {
        const glueTableName = `${basename}_${tableName}`; // Match S3 Table name convention
        return [
            tableName, // Keep original key for mapping
            new aws.glue.CatalogTable(`GlueCatalogTable${tableName}`, {
                name: glueTableName, // Use explicit name
                databaseName: glueCatalogDatabase.name,
                // tableType: "EXTERNAL_TABLE", // *** VITAL: Must be EXTERNAL_TABLE for Iceberg managed by S3 Tables/LF
                parameters: {
                    "table_type": "ICEBERG", // Identify as Iceberg
                    "classification": "iceberg", // Can also be parquet if Firehose converts first
                    "lakeformation.governed": "true", // *** VITAL: Indicate LF governance
                    // Add other relevant parameters if needed
                },
                storageDescriptor: {
                    // *** VITAL: Location points to the path *within* the S3 Table Bucket ***
                    location: $interpolate`s3://${s3TableBucket.id}/${glueTableName}/`, // Use bucketId (name) and table name
                    columns: glueColumns[tableName], // Schema from import
                    // *** VITAL: Define SerDe for underlying Parquet format ***
                    inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
                    outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
                    serDeInfo: {
                        serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
                        parameters: { "serialization.format": "1" },
                    },
                    compressed: false, // Parquet SerDe handles compression (e.g., SNAPPY)
                    storedAsSubDirectories: false, // Iceberg manages directory structure
                },
                // partitionKeys: commonPartitionKeys,
                // *** VITAL: Define Open Table Format Input for Iceberg ***
                openTableFormatInput: {
                    icebergInput: {
                        metadataOperation: "CREATE", // Use CREATE for definition
                        version: "2", // Common Iceberg version
                    }
                }
            })
        ];
    })) as Record<TableName, aws.glue.CatalogTable>; // Type assertion

    // === IAM Role for Firehose ===
    // *** VITAL CHANGE: Use explicit role name based on basename ***
    const firehoseDeliveryRole = new aws.iam.Role(`FirehoseDeliveryRole`, {
      name: `${basename}-firehose-delivery-role`, // Use explicit, stage-specific name
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // Allow Firehose to write to S3 and access Glue (Updated for Iceberg)
    // *** VITAL CHANGE: Updated S3 and Glue permissions for Iceberg ***
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
              "${s3TableBucket.arn}",
              "${s3TableBucket.arn}/*"
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

    // === Lake Formation Permissions for Firehose ===
    // Grant DESCRIBE on the Glue Database
    new aws.lakeformation.Permissions(`FirehoseDbDescribePermission`, {
      principal: firehoseDeliveryRole.arn,
      permissions: ["DESCRIBE"],
      database: {
        catalogId: accountId,
        name: glueCatalogDatabase.name,
      },
    });

    // Grant Table permissions and Data Location access for each table
    tableNames.forEach(tableName => {
      const glueTable = glueTables[tableName]; // Get the specific Glue table resource

      // Table Permissions
      // *** VITAL CHANGE: Added ALTER permission for Iceberg operations ***
      new aws.lakeformation.Permissions(`FirehoseTablePermissions_${tableName}`, {
        principal: firehoseDeliveryRole.arn,
        permissions: ["SELECT", "INSERT", "ALTER", "DESCRIBE"], // ALTER is needed
        table: {
          catalogId: accountId,
          databaseName: glueCatalogDatabase.name,
          name: glueTable.name, // Use the actual Glue table name output
        },
        permissionsWithGrantOptions: [], // Explicitly empty is important
      });

      // Data Location Permissions
      // *** VITAL CHANGE: Grant DATA_LOCATION_ACCESS on the S3 Table Bucket ARN ***
      new aws.lakeformation.Permissions(`FirehoseDataLocationPermissions_${tableName}`, {
        principal: firehoseDeliveryRole.arn,
        permissions: ["DATA_LOCATION_ACCESS"],
        dataLocation: {
          catalogId: accountId,
          // Grant access to the S3 Table Bucket itself
          arn: s3TableBucket.arn
        },
        permissionsWithGrantOptions: [], // Explicitly empty is important
      });
    });

    // === Kinesis Data Firehose Delivery Streams ===
    // *** VITAL CHANGE: Configure destination: "iceberg" ***
    const firehoses = Object.fromEntries(tableNames.map(tableName => {
        const glueTable = glueTables[tableName]; // Get the specific Glue table resource
        return [
            tableName, // Keep original key for mapping
            new aws.kinesis.FirehoseDeliveryStream(`FirehoseStream${tableName}`, {
                // *** VITAL CHANGE: Use explicit stream name based on basename ***
                name: `${basename}-firehose-${tableName}`, // Use explicit, stage-specific name
                destination: "iceberg", // *** VITAL: Set destination to Iceberg ***
                tags: { // Add useful tags
                    Environment: $app.stage,
                    Project: $app.name,
                    Table: tableName,
                },
                // *** VITAL: Use icebergConfiguration block ***
                icebergConfiguration: {
                    roleArn: firehoseDeliveryRole.arn, // Role created above
                    // *** VITAL: Provide Glue Catalog ARN ***
                    catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
                    bufferingInterval: 60, // Default 60s
                    bufferingSize: 64,     // Default 64MB
                    // *** VITAL: s3Configuration points to the S3 Table Bucket ***
                    s3Configuration: {
                        roleArn: firehoseDeliveryRole.arn, // Same role
                        // bucketArn: s3TableBucket.arn,      // ARN of the S3 Table Bucket
                        bucketArn: $interpolate`arn:aws:s3:::${s3TableBucket.name}`,      // ARN of the S3 Table Bucket
                        // Error prefix within the S3 Table Bucket
                        errorOutputPrefix: $interpolate`firehose-errors/${glueTable.name}/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/`,
                        // No prefix, compression, data format conversion, dynamic partitioning here - Handled by Iceberg dest / Glue table
                    },
                    // *** VITAL: Destination table config links to Glue Table ***
                    destinationTableConfigurations: [{
                        databaseName: glueCatalogDatabase.name,
                        tableName: glueTable.name, // Use the actual Glue table name output
                    }],
                    // Processing Configuration - Only needed if input JSON needs transformation *before* Iceberg write
                    // processingConfiguration: { enabled: false }, // Disabled by default
                    // Optional: CloudWatch logging for Iceberg destination specifics
                    // cloudwatchLoggingOptions: {
                    //    enabled: true,
                    //    logGroupName: $interpolate`/aws/kinesisfirehose/${basename}-firehose-${tableName}`, // Match name pattern
                    //    logStreamName: "IcebergDelivery",
                    // },
                },
                // Remove extendedS3Configuration, dynamicPartitioningConfiguration, dataFormatConversionConfiguration
            })
        ];
    })) as Record<TableName, aws.kinesis.FirehoseDeliveryStream>; // Type assertion


    // === Cognito User Pool (Using SST Component) ===
    // *** VITAL CHANGE: Use explicit User Pool name based on basename ***
    const userPool = new sst.aws.CognitoUserPool("UserPool", {
      usernames: ["email"],
      transform: {
        userPool: (args) => {
          args.name = `${basename}-user-pool`; // Explicit name
          args.passwordPolicy = {
            minimumLength: 8, // Keep slightly more secure default
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: false,
            requireUppercase: true,
            temporaryPasswordValidityDays: 7,
          };
          args.accountRecoverySetting = { // Add recovery setting
             recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
          };
        },
      }
    });
    // *** VITAL CHANGE: Use explicit User Pool Client name based on basename ***
    const userPoolClientSst = userPool.addClient("UserPoolClient", {
       // name: `${basename}-web-client`, // Explicit name
       // transform can be used here if needed for specific client settings
       // transform: { client: (args) => { ... }}
    });

    // === DynamoDB Tables ===
    // *** VITAL CHANGE: Use explicit table names based on basename ***
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
    // *** VITAL CHANGE: Use explicit table names based on basename ***
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
        // Use the explicit Firehose stream names
        EVENTS_FIREHOSE_STREAM_NAME: firehoses.events.name,
        INITIAL_EVENTS_FIREHOSE_STREAM_NAME: firehoses.initial_events.name,
        SITES_TABLE_NAME: sitesTable.name,
        USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
      },
      permissions: [
        {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources: [sitesTable.arn]},
        {actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn]},
        // Firehose PutRecord permissions are handled by linking
      ],
    });
    // *** VITAL CHANGE: Explicitly route POST /api/event via Router ***
    // router.route("POST /api/event", ingestFn.arn);
    // router.route("/api/event", ingestFn.arn);


    const queryFn = new sst.aws.Function("QueryFn", {
      handler: "functions/analytics/query.handler",
      timeout: "60 second",
      memory: "512 MB",
      architecture: "arm64", // Use ARM
      // NOTE: queryFn is NOT attached to the public Router
      link: [
        glueCatalogDatabase, // Link DB
        // *** VITAL: Link the actual Glue Table resources ***
        glueTables.events,
        glueTables.initial_events,
        athenaResultsBucket, // Link results bucket
        s3TableBucket,       // Link S3 Table bucket (for underlying data access via LF/Athena)
        sitesTable,
        userPreferencesTable,
      ],
      environment: {
        // *** VITAL: Use the actual Glue table names ***
        ATHENA_INITIAL_EVENTS_TABLE: glueTables.initial_events.name,
        ATHENA_EVENTS_TABLE: glueTables.events.name,
        GLUE_DATABASE_NAME: glueCatalogDatabase.name,
        ATHENA_RESULTS_BUCKET: athenaResultsBucket.name,
        USE_STRIPE: useStripe.toString(),
      },
      permissions: [
        // Athena permissions (scoped slightly)
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"], resources: ["*"] }, // Can scope further if needed
        // Glue/S3 permissions primarily handled by linking + Lake Formation
        // Explicit S3 permissions for Athena writing results & reading data (via LF)
        { actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:DeleteObject"], resources: [athenaResultsBucket.arn, `${athenaResultsBucket.arn}/*`] },
        { actions: ["s3:GetObject*", "s3:ListBucket*"], resources: [s3TableBucket.arn, `${s3TableBucket.arn}/*`] }, // Read access to data bucket
        // Lake Formation permissions (basic action needed by Athena engine)
        { actions: ["lakeformation:GetDataAccess"], resources: ["*"] },
        // DynamoDB permissions handled by linking
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
        // Allow CRUD operations on userPreferencesTable
        { actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [userPreferencesTable.arn] },
      ],
      environment: { // Step 7: Add USE_STRIPE
        USE_STRIPE: useStripe.toString(),
        USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name, // Pass table name
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
        environment: { // Step 7: Add USE_STRIPE (conditionally)
          USE_STRIPE: useStripe.toString(),
          SITES_TABLE_NAME: sitesTable.name,
          USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
        },
        permissions: [
          {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources: [userPreferencesTable.arn]},
          // Allow update and query on sites table + indexes
          {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"], resources: [sitesTable.arn, `${sitesTable.arn}/index/*`]},
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
        // *** VITAL: Allow localhost for dev, specific domain for prod ***
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
    // api.route("GET    /api/query", { handler: queryFn.arn, ...commonAuth });
    // api.route("POST   /api/sites", { handler: sitesFn.arn, ...commonAuth });
    // api.route("GET    /api/sites", { handler: sitesFn.arn, ...commonAuth });
    // api.route("GET    /api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth });
    // api.route("PUT    /api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth });
    // api.route("DELETE /api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth }); // Add DELETE
    // api.route("GET    /api/sites/{site_id}/script", { handler: sitesFn.arn, ...commonAuth }); // Add script route
    // api.route("GET    /api/user/preferences", { handler: preferencesFn.arn, ...commonAuth });
    // api.route("PUT    /api/user/preferences", { handler: preferencesFn.arn, ...commonAuth });
    api.route("/api/query", { handler: queryFn.arn, ...commonAuth });
    api.route("/api/sites", { handler: sitesFn.arn, ...commonAuth });
    api.route("/api/sites", { handler: sitesFn.arn, ...commonAuth });
    api.route("/api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth });
    api.route("/api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth });
    api.route("/api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth }); // Add DELETE
    api.route("/api/sites/{site_id}/script", { handler: sitesFn.arn, ...commonAuth }); // Add script route
    api.route("/api/user/preferences", { handler: preferencesFn.arn, ...commonAuth });
    api.route("/api/user/preferences", { handler: preferencesFn.arn, ...commonAuth });

    // Step 5: Conditional Stripe API Routes
    if (useStripe && stripeFn) { // Check stripeFn exists
      // api.route("POST   /api/stripe/webhook", { handler: stripeFn.arn }); // NO auth needed
      // api.route("POST   /api/stripe/checkout", { handler: stripeFn.arn, ...commonAuth }); // Requires JWT auth
      // api.route("GET    /api/stripe/portal", { handler: stripeFn.arn, ...commonAuth }); // Add portal route
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

    // === Compaction Function & Cron (REMOVED) ===
    // S3 Tables / Glue handle Iceberg compaction automatically.

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
        environment: { // Step 7: Add USE_STRIPE (conditionally)
          USE_STRIPE: useStripe.toString(),
          SITES_TABLE_NAME: sitesTable.name,
          USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
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
      // *** VITAL: Output correct data bucket name (id) ***
      dataBucketName: s3TableBucket.id, // Output the physical bucket ID/name
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: firehoses.events.name,
      initialEventsFirehoseStreamName: firehoses.initial_events.name,
      glueDatabasename: glueCatalogDatabase.name,
      // *** VITAL: Output correct Glue table names ***
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