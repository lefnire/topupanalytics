/// <reference path="../.sst/platform/config.d.ts" />

/*
... (Keep your existing comments) ...
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
    const useStripe = process.env.USE_STRIPE === 'true';
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId
    const region = aws.getRegionOutput({}).name // Use output version
    const partition = aws.getPartitionOutput({}).partition // Get partition (e.g., "aws")
    const baseName = `${$app.name}-${$app.stage}`; // Use hyphenated baseName consistently

    // Placeholder values instead of sst.Secret.create
    const DUMMY_STRIPE_SECRET_KEY_PLACEHOLDER = "dummy_stripe_secret_key_placeholder";
    const DUMMY_STRIPE_WEBHOOK_SECRET_PLACEHOLDER = "dummy_stripe_webhook_secret_placeholder";
    const DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER = "dummy_stripe_publishable_key_placeholder";


    // === Linkable Wrappers (using global sst) ===
    // Wrap Kinesis Firehose Delivery Stream
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: {name: stream.name},
      include: [
        sst.aws.permission({
          actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [stream.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Database
    sst.Linkable.wrap(aws.glue.CatalogDatabase, (db) => ({
      properties: {name: db.name, arn: db.arn},
      include: [
        sst.aws.permission({
          actions: ["glue:GetDatabase"],
          resources: [db.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Table
    sst.Linkable.wrap(aws.glue.CatalogTable, (table) => ({
      properties: {name: table.name, arn: table.arn, databaseName: table.databaseName},
      include: [
        sst.aws.permission({
          actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions", "glue:GetPartition", "glue:GetPartitions"], // Read actions
          resources: [
            table.arn,
            $interpolate`arn:aws:glue:${region}:${accountId}:database/${table.databaseName}`,
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`,
           ],
        }),
      ],
    }));

    /*
     S3 Tables setup - Using aws.s3tables constructs.
     This automatically creates Iceberg tables managed by Glue/Lake Formation.
    */
    const tableNames = ['events', 'initial_events'] as const;
    type TableName = typeof tableNames[number]; // Define a type for table names

    const s3TableBucket = new aws.s3tables.TableBucket("S3TableBucket", {
        name: `${baseName}-s3-table-bucket`, // Provide explicit name
    });

    const s3TableNamespace = new aws.s3tables.Namespace("S3TableNamespace", {
        namespace: `${baseName.replace(/-/g, '_')}_ns`, // Ensure underscores, use baseName
        tableBucketArn: s3TableBucket.arn,
    });

    // We still define Glue resources because Firehose Iceberg destination requires them.
    // S3 Tables *manages* the underlying Iceberg format/metadata, but Firehose interacts via Glue.

    // === Glue Data Catalog ===
    const glueCatalogDatabase = new aws.glue.CatalogDatabase(`GlueCatalogDatabase`, {
      name: `${baseName.replace(/-/g, '_')}_db`, // Use baseName, replace hyphens
      // LocationUri points to where Glue *stores its metadata* about the database,
      // not necessarily where all table data resides for EXTERNAL tables like Iceberg.
      // S3 Tables manages its own data location within the s3TableBucket.
      // Let's point this to a path within the managed bucket for tidiness.
      locationUri: $interpolate`s3://${s3TableBucket.name}/_glue_database/`,
    });

    // Import schemas for both tables
    const {initialGlueColumns, eventsGlueColumns} = await import('./functions/analytics/schema');
    const glueColumns: Record<TableName, aws.types.input.glue.CatalogTableStorageDescriptorColumn[]> = {
        events: eventsGlueColumns,
        initial_events: initialGlueColumns
    };

    // Define partition keys once for consistency
    const commonPartitionKeys: aws.types.input.glue.CatalogTablePartitionKey[] = [
      {name: "site_id", type: "string"},
      {name: "dt", type: "string"}, // dt format typically yyyy-MM-dd
    ];

    // Create Glue tables corresponding to the S3 Tables concept.
    // Firehose Iceberg destination requires these Glue tables to exist.
    const glueTables = Object.fromEntries(tableNames.map(tableName => {
      const glueTableName = `${baseName.replace(/-/g, '_')}_${tableName}`; // Construct Glue table name
      return [
        tableName, // Keep original key 'events' or 'initial_events' for mapping
        new aws.glue.CatalogTable(`GlueCatalogTable${tableName}`, {
          name: glueTableName, // Use the constructed name
          databaseName: glueCatalogDatabase.name,
          tableType: "EXTERNAL_TABLE", // S3 Tables are external from Glue's perspective
          parameters: {
            "table_type": "ICEBERG", // Critical parameter for Iceberg
            "classification": "iceberg", // Or parquet if Firehose converts *before* Iceberg write? Let's stick to iceberg.
            // Add S3 Table specific parameters if documented/required. Often handled by Lake Formation integration.
            "lakeformation.governed": "true", // Indicate LF governance
          },
          storageDescriptor: {
            // Location points to the *base path* within the S3 Table Bucket where this table's data will reside.
            // S3 Tables typically manages subdirectories under this.
            location: $interpolate`s3://${s3TableBucket.name}/${glueTableName}/`, // Use bucketId and table name
            // Schema defined here is used by Firehose for validation/conversion if no processor used.
            columns: glueColumns[tableName],
            // Input/Output format should reflect Iceberg's underlying format (usually Parquet)
            inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
            outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
            serDeInfo: {
              serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
              parameters: { "serialization.format": "1" },
            },
            compressed: false, // Compression handled by Parquet SerDe
            storedAsSubDirectories: false, // Iceberg manages directory structure
          },
          partitionKeys: commonPartitionKeys,
          // Define openTableFormatInput for Iceberg explicitly
          openTableFormatInput: {
            icebergInput: {
                metadataOperation: "CREATE", // Indicates this definition creates the Iceberg metadata structure
                version: "2", // Specify Iceberg format version (usually 2)
            }
          }
        })
      ];
    })) as Record<TableName, aws.glue.CatalogTable>; // Type assertion


    // === S3 Tables (Physical Table Resources) ===
    // These might not be strictly needed if Glue table definition is sufficient,
    // but they represent the S3 Tables concept more directly.
    // Let's keep them for now as they might enforce S3 Table specific configs.
    // Note: The name here needs to match the `location` path segment in Glue Table? Or is it independent? Let's assume independent for now.
    const s3Tables = Object.fromEntries(tableNames.map(tableName => {
      const s3TableName = `${baseName.replace(/-/g, '_')}_${tableName}`; // Match Glue table name convention
      return [
        tableName,
        new aws.s3tables.Table(`S3Table${tableName}`, {
            // Name corresponds to the logical S3 Table name, likely matching Glue table name.
            name: s3TableName,
            namespace: s3TableNamespace.namespace,
            tableBucketArn: s3TableBucket.arn, // Use ARN here
            format: "ICEBERG", // Explicitly ICEBERG
            // Columns and Partitions are defined in the Glue Table.
            // maintenanceConfiguration: { // Optional: Configure compaction/snapshot settings if needed
            //   icebergCompaction: { status: "ENABLED", settings: { targetFileSizeMb: 512 } },
            //   icebergSnapshotManagement: { status: "ENABLED", settings: { maxSnapshotAgeHours: 720, minSnapshotsToKeep: 1 } },
            // },
        })
      ];
    })) as Record<TableName, aws.s3tables.Table>;


    // === Secrets ===
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined; // For frontend


    // === S3 Buckets ===
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {
        // name: `${baseName}-athena-results`, // Explicit name
    });

    // === Common S3 Lifecycle Rule for Intelligent Tiering ===
    // Not needed for S3 Table Bucket (managed differently)
    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`AthenaResultsBucketLifecycle`, {
      bucket: athenaResultsBucket.name,
      rules: [{
        id: "IntelligentTieringRule",
        status: "Enabled",
        filter: {},
        transitions: [{ days: 0, storageClass: "INTELLIGENT_TIERING" }],
      }],
    });


    // === IAM Role for Firehose ===
    const firehoseDeliveryRole = new aws.iam.Role(`FirehoseDeliveryRole`, {
      name: `${baseName}-firehose-delivery-role`, // Explicit name
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // === Updated Firehose Delivery Policy for Iceberg ===
    new aws.iam.RolePolicy(`FirehoseDeliveryPolicy`, {
      role: firehoseDeliveryRole.id,
      policy: $jsonStringify({ // Use jsonStringify for better structure and interpolation handling
        Version: "2012-10-17",
        Statement: [
          // S3 Permissions for the S3 Table Bucket
          {
            Effect: "Allow",
            Action: [
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation",
              "s3:GetObject",
              "s3:ListBucket",
              "s3:ListBucketMultipartUploads",
              "s3:PutObject",
              // Potentially needed for Iceberg metadata/manifest files
              "s3:DeleteObject",
              "s3:GetBucketAcl", // Might be needed by Iceberg operations
              "s3:GetObjectAcl",
              "s3:PutObjectAcl"
            ],
            Resource: [
              s3TableBucket.arn, // Grant on the bucket ARN
              $interpolate`${s3TableBucket.arn}/*` // Grant on objects within the bucket
            ]
          },
          // Glue Permissions for Catalog, Database, and Tables
          {
            Effect: "Allow",
            Action: [
              "glue:GetDatabase",
              "glue:GetTable",
              "glue:GetTableVersion", // Read actions
              "glue:GetTableVersions",
              "glue:GetPartitions", // Needed for Iceberg partition handling
              "glue:BatchCreatePartition", // Needed to create new partitions
              "glue:BatchUpdatePartition", // Potentially needed
              "glue:UpdateTable", // Needed to update table metadata (e.g., location, stats)
              // Actions potentially needed for schema evolution/updates by Firehose/Iceberg
              "glue:CreateTable", // If Firehose needs to create the table? Unlikely if pre-created.
              "glue:UpdateDatabase",
            ],
            Resource: [
              $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Catalog resource
              glueCatalogDatabase.arn, // Database resource ARN
              glueTables.events.arn, // Events table ARN
              glueTables.initial_events.arn // Initial Events table ARN
            ]
          },
          // CloudWatch Logs Permissions
          {
            Effect: "Allow",
            Action: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents"
            ],
            Resource: $interpolate`arn:${partition}:logs:${region}:${accountId}:log-group:/aws/kinesisfirehose/${baseName}-firehose-*:log-stream:*` // More specific log group pattern
          },
          // Lake Formation permissions are granted separately using aws.lakeformation.Permissions
        ]
      }),
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
      const glueTable = glueTables[tableName]; // Get the Pulumi resource

      // Table Permissions (Need ALTER for Iceberg operations)
      new aws.lakeformation.Permissions(`FirehoseTablePermissions_${tableName}`, {
        principal: firehoseDeliveryRole.arn,
        permissions: ["SELECT", "INSERT", "ALTER", "DESCRIBE"], // Added ALTER
        table: {
          catalogId: accountId,
          databaseName: glueCatalogDatabase.name,
          name: glueTable.name, // Use the actual Glue table name
        },
        permissionsWithGrantOptions: [],
      });

      // Data Location Permissions - Point to the S3 Table *Bucket* ARN
      // Lake Formation needs access to the bucket where the table data resides.
      new aws.lakeformation.Permissions(`FirehoseDataLocationPermissions_${tableName}`, {
        principal: firehoseDeliveryRole.arn,
        permissions: ["DATA_LOCATION_ACCESS"],
        dataLocation: {
          catalogId: accountId,
          // Grant access to the S3 Table Bucket ARN
          arn: s3TableBucket.arn
        },
        permissionsWithGrantOptions: [],
      });
    });


    // === Kinesis Data Firehose Delivery Streams (Using ICEBERG Destination) ===
    const firehoses = Object.fromEntries(tableNames.map(tableName => {
        const glueTable = glueTables[tableName]; // Get the Pulumi resource
        return [
            tableName,
            new aws.kinesis.FirehoseDeliveryStream(`FirehoseStream${tableName}`, {
                name: `${baseName}-firehose-${tableName}`, // Consistent naming
                destination: "iceberg", // Set destination to Iceberg
                tags: { // Add useful tags
                    Environment: $app.stage,
                    Project: $app.name,
                    Table: tableName,
                },
                icebergConfiguration: {
                    roleArn: firehoseDeliveryRole.arn, // Role with S3, Glue, LF permissions
                    // Catalog ARN identifies the Glue Data Catalog
                    catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
                    // Buffering hints control batching before writing to Iceberg
                    bufferingInterval: 60, // In seconds (e.g., 60-900)
                    bufferingSize: 64,     // In MBs (e.g., 64-128)
                    // S3 configuration for the underlying storage
                    s3Configuration: {
                        roleArn: firehoseDeliveryRole.arn, // Same role usually sufficient
                        bucketArn: s3TableBucket.arn,    // ARN of the S3 Table Bucket
                        // Error output prefix within the S3 Table Bucket
                        errorOutputPrefix: `firehose-errors/${glueTable.name}/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/`,
                        // Compression is handled by Iceberg/Parquet, not needed here
                        // Prefix is managed by Iceberg partitioning based on Glue table, not set here
                    },
                    // Destination table configuration linking to Glue
                    destinationTableConfigurations: [{
                        databaseName: glueCatalogDatabase.name,
                        tableName: glueTable.name, // Name of the Glue table
                    }],
                    // Processing Configuration:
                    // If input JSON needs transformation or schema validation *before* Iceberg write,
                    // enable this and add a Lambda processor.
                    // For now, assume Firehose uses Glue schema for conversion.
                    // processingConfiguration: {
                    //   enabled: true,
                    //   processors: [{
                    //       type: "Lambda",
                    //       parameters: [{
                    //           parameterName: "LambdaArn",
                    //           parameterValue: yourConversionLambda.arn, // Replace with your Lambda ARN
                    //       }],
                    //   }],
                    // },

                    // Optional: Retry options for Iceberg write failures
                    // retryOptions: { durationInSeconds: 300 },

                    // Optional: CloudWatch logging for Iceberg destination specifics
                    cloudwatchLoggingOptions: {
                       enabled: true,
                       logGroupName: $interpolate`/aws/kinesisfirehose/${baseName}-firehose-${tableName}`,
                       logStreamName: "IcebergDelivery", // Specific stream name for Iceberg logs
                    },
                },
                // Note: Dynamic Partitioning and DataFormatConversion are NOT used with 'iceberg' destination.
                // Partitioning is based on the 'partitionKeys' in the Glue table definition.
                // Data format conversion is implicitly handled based on Glue schema or requires a processor.
            })
        ];
    })) as Record<TableName, aws.kinesis.FirehoseDeliveryStream>; // Type assertion


    // === Cognito User Pool ===
    const userPool = new sst.aws.CognitoUserPool("UserPool", {
        usernames: ["email"],
        transform: {
            userPool: (args) => {
                args.name = `${baseName}-user-pool`; // Explicit name
                args.passwordPolicy = {
                    minimumLength: 8, // Slightly more secure default
                    requireLowercase: true,
                    requireNumbers: true,
                    requireSymbols: false,
                    requireUppercase: true,
                    temporaryPasswordValidityDays: 7,
                };
                // Add account recovery setting if desired
                args.accountRecoverySetting = {
                  recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
                };
            },
        }
    });
    const userPoolClientSst = userPool.addClient("UserPoolClient", {
        // name: `${baseName}-web-client`, // Explicit name
        transform: {
            client: (args) => {
                 // Configure OAuth flows if needed for direct federation or advanced auth
                 // args.allowedOauthFlows = ["code", "implicit"];
                 // args.allowedOauthScopes = ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"];
                 // args.callbackUrls = ["http://localhost:3000/callback"]; // Example callback
                 // args.logoutUrls = ["http://localhost:3000/logout"]; // Example logout
            }
        }
    });

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      // name: `${baseName}-sites`, // Explicit name
      fields: { site_id: "string", owner_sub: "string", plan: "string" },
      primaryIndex: {hashKey: "site_id"},
      globalIndexes: {
        ownerSubIndex: {hashKey: "owner_sub", projection: ["site_id"]},
        planIndex: {hashKey: "plan", projection: "all"},
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      // name: `${baseName}-user-preferences`, // Explicit name
      fields: { cognito_sub: "string" },
      primaryIndex: {hashKey: "cognito_sub"},
    });

    // === Router for Public Endpoints (Ingest + Dashboard) ===
    const router = new sst.aws.Router("PublicRouter", {
      domain: isProd ? domain : undefined,
      // Optional: Add custom error responses
      // errorResponses: [
      //   { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html" },
      // ],
    });

    // === API Functions ===
    const ingestFn = new sst.aws.Function("IngestFn", {
      handler: "functions/analytics/ingest.handler",
      timeout: '10 second',
      memory: "128 MB",
      architecture: "arm64", // Use ARM for potential cost/perf benefits
      url: {
        cors: true, // Allow CORS for direct invocation if needed, but primary access is Router
        // Attach to router for public access via CloudFront
        authorizer: "none", // Explicitly none for public endpoint
      },
      link: [
        firehoses.events,
        firehoses.initial_events,
        sitesTable,
        userPreferencesTable
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        // Pass Firehose stream names directly
        EVENTS_FIREHOSE_STREAM_NAME: firehoses.events.name,
        INITIAL_EVENTS_FIREHOSE_STREAM_NAME: firehoses.initial_events.name,
        SITES_TABLE_NAME: sitesTable.name,
        USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
      },
      permissions: [
        {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources: [sitesTable.arn]},
        {actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn]},
        // Linking Firehose provides PutRecord/PutRecordBatch automatically
      ],
    });
     // Route /api/event POST requests via Router to ingestFn
     router.route("POST /api/event", ingestFn.arn);

    const queryFn = new sst.aws.Function("QueryFn", {
      handler: "functions/analytics/query.handler",
      timeout: "60 second",
      memory: "512 MB",
      architecture: "arm64",
      // NOTE: queryFn is NOT attached to the public Router
      // It will be attached to the authenticated ApiGatewayV2 below
      link: [
        glueCatalogDatabase, // Link DB
        // Link Glue Tables directly
        glueTables.events,
        glueTables.initial_events,
        athenaResultsBucket, // Link results bucket
        s3TableBucket,       // Link S3 Table bucket (underlying storage)
        sitesTable,
        userPreferencesTable,
      ],
      environment: {
        // Pass actual Glue table names
        ATHENA_INITIAL_EVENTS_TABLE: glueTables.initial_events.name,
        ATHENA_EVENTS_TABLE: glueTables.events.name,
        GLUE_DATABASE_NAME: glueCatalogDatabase.name,
        ATHENA_RESULTS_BUCKET: athenaResultsBucket.name,
        USE_STRIPE: useStripe.toString(),
      },
      permissions: [
        // Athena permissions
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"], resources: ["*"] }, // Scope down if needed
        // Glue permissions are handled by linking the tables/database
        // S3 permissions (Results Bucket + Data Bucket) are handled by linking
        // Explicit S3 access for Athena to write results and read data
        { actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:DeleteObject"], resources: [athenaResultsBucket.arn, `${athenaResultsBucket.arn}/*`] },
        { actions: ["s3:GetObject", "s3:ListBucket"], resources: [s3TableBucket.arn, `${s3TableBucket.arn}/*`] },
        // Lake Formation Permissions for the Lambda's Execution Role
        // The Lambda role needs permissions on the Glue resources and S3 location via LF
        {
            actions: ["lakeformation:GetDataAccess"], // Action needed by Athena engine
            resources: ["*"] // Usually scoped broadly or handled by service-linked roles
        },
        // Permissions for DynamoDB handled by linking
      ],
    });


    // === Management API Functions ===
    const sitesFn = new sst.aws.Function("SitesFn", {
      handler: "functions/api/sites.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64",
      link: [sitesTable, router], // Link router to get its URL
      permissions: [
        { actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"], resources: [sitesTable.arn, `${sitesTable.arn}/index/*`] },
      ],
      environment: {
        ROUTER_URL: router.url, // Pass the base router URL
        USE_STRIPE: useStripe.toString(),
        SITES_TABLE_NAME: sitesTable.name, // Pass table name if needed by handler
      },
      nodejs: { install: ["ulid"] }
    });

    const preferencesFn = new sst.aws.Function("PreferencesFn", {
      handler: "functions/api/preferences.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64",
      link: [userPreferencesTable],
      permissions: [
        { actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [userPreferencesTable.arn] },
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name, // Pass table name
      },
    });

    let stripeFn: sst.aws.Function | undefined;
    if (useStripe) {
      stripeFn = new sst.aws.Function("StripeFn", {
        handler: "functions/api/stripe.handler",
        timeout: "10 second",
        memory: "128 MB",
        architecture: "arm64",
        link: [
          STRIPE_SECRET_KEY!,
          STRIPE_WEBHOOK_SECRET!,
          userPreferencesTable,
          sitesTable,
        ],
        environment: {
          USE_STRIPE: useStripe.toString(),
          SITES_TABLE_NAME: sitesTable.name,
          USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
        },
        permissions: [
          {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources: [userPreferencesTable.arn]},
          {actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"], resources: [sitesTable.arn, `${sitesTable.arn}/index/*`]}, // Allow query on indexes too
        ],
        nodejs: { install: ["stripe"] }
      });
    }

    // === API Gateway (for Authenticated Endpoints) ===
    const api = new sst.aws.ApiGatewayV2("ManagementApi", {
      domain: isProd ? { name: `api.${domain}` } : undefined,
      cors: {
        allowOrigins: isProd ? [`https://${domain}`] : ["http://localhost:5173", "http://127.0.0.1:5173"], // Allow specific dev origins + prod
        allowCredentials: true, // Needed for Cognito JWTs
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClientSst.id],
      }
    });

    const commonAuth = {auth: {jwt: {authorizer: jwtAuthorizer.id}}};

    // --- Management API Routes ---
    api.route("GET    /api/query", { handler: queryFn.arn, ...commonAuth });
    api.route("POST   /api/sites", { handler: sitesFn.arn, ...commonAuth });
    api.route("GET    /api/sites", { handler: sitesFn.arn, ...commonAuth });
    api.route("GET    /api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth });
    api.route("PUT    /api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth });
    api.route("DELETE /api/sites/{site_id}", { handler: sitesFn.arn, ...commonAuth }); // Add DELETE
    api.route("GET    /api/sites/{site_id}/script", { handler: sitesFn.arn, ...commonAuth }); // Add script endpoint
    api.route("GET    /api/user/preferences", { handler: preferencesFn.arn, ...commonAuth });
    api.route("PUT    /api/user/preferences", { handler: preferencesFn.arn, ...commonAuth });

    if (useStripe && stripeFn) {
      api.route("POST   /api/stripe/webhook", { handler: stripeFn.arn }); // No auth
      api.route("POST   /api/stripe/checkout", { handler: stripeFn.arn, ...commonAuth });
      api.route("GET    /api/stripe/portal", { handler: stripeFn.arn, ...commonAuth }); // Add portal endpoint
    }

    // === Dashboard (React Frontend) ===
    const publicIngestUrl = $interpolate`${router.url}/api/event`;
    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      // Attach dashboard to the root of the public Router
      router: { instance: router },
      link: [ api, userPool, userPoolClientSst ],
      environment: {
        VITE_COGNITO_USER_POOL_ID: userPool.id,
        VITE_COGNITO_CLIENT_ID: userPoolClientSst.id,
        VITE_AWS_REGION: region,
        VITE_API_URL: api.url,
        VITE_APP_URL: router.url, // Main app URL is router URL
        VITE_STRIPE_PUBLISHABLE_KEY: useStripe ? STRIPE_PUBLISHABLE_KEY!.value : DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER,
        VITE_USE_STRIPE: useStripe.toString(),
        VITE_PUBLIC_INGEST_URL: publicIngestUrl,
      },
      dev: {
        deploy: true, // Deploy frontend in dev stage
        // Optional: Specify local dev server URL if needed
        // url: "http://localhost:5173",
      }
    });

    // === Billing / Usage Processing (Conditional) ===
    let chargeProcessorFn: sst.aws.Function | undefined;
    if (useStripe) {
      chargeProcessorFn = new sst.aws.Function("ChargeProcessorFn", {
        handler: "functions/billing/chargeProcessor.handler",
        timeout: "60 second",
        memory: "256 MB",
        architecture: "arm64",
        link: [
          sitesTable,
          userPreferencesTable,
          STRIPE_SECRET_KEY!,
        ],
        environment: {
          USE_STRIPE: useStripe.toString(),
          SITES_TABLE_NAME: sitesTable.name,
          USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
        },
        permissions: [
          // Query sites needing payment using the GSI
          {actions: ["dynamodb:Query"], resources: [`${sitesTable.arn}/index/planIndex`]},
          // Get user preferences to find payment details
          {actions: ["dynamodb:GetItem"], resources: [userPreferencesTable.arn]},
          // Update site allowance/plan after successful charge
          {actions: ["dynamodb:UpdateItem"], resources: [sitesTable.arn]},
          // Update user payment status after failed charge
          {actions: ["dynamodb:UpdateItem"], resources: [userPreferencesTable.arn]},
        ],
        nodejs: { install: ["stripe", "@aws-sdk/client-dynamodb"] }
      });

      new sst.aws.Cron("ChargeCron", {
        job: chargeProcessorFn.arn,
        schedule: "rate(5 minutes)", // Consider adjusting schedule based on load/cost
      });
    }

    // === Outputs ===
    return {
      appName: $app.name,
      stage: $app.stage,
      accountId: accountId,
      region: region,
      dashboardUrl: router.url,
      managementApiUrl: api.url,
      publicIngestUrl: publicIngestUrl,
      // Function Names (useful for monitoring/logs)
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      sitesFunctionName: sitesFn?.name,
      preferencesFunctionName: preferencesFn?.name,
      stripeFunctionName: stripeFn?.name,
      chargeProcessorFunctionName: chargeProcessorFn?.name,
      // Data Resources
      s3TableBucketName: s3TableBucket.name, // Use bucketId (physical name)
      s3TableBucketArn: s3TableBucket.arn,
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: firehoses.events.name,
      initialEventsFirehoseStreamName: firehoses.initial_events.name,
      glueDatabaseName: glueCatalogDatabase.name,
      eventsGlueTableName: glueTables.events.name,
      initialEventsGlueTableName: glueTables.initial_events.name,
      // Auth Resources
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      // DynamoDB Tables
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      // Stripe specific (conditional)
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined,
      isProd,
      routerDistributionId: router.distributionID,
    }
  },
});