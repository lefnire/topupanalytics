/// <reference path="./.sst/platform/config.d.ts" />
/*
## Instructions
This uses SST v3, which uses Pulumi under the hood - not CDK (SST v2). SST v3 adds a global variable `aws`, which is an augmented version of the `aws` you'd import from Pulumi. Never try to add imports to this file, always use the global `aws`, and assume it has what you'd need from Pulumi. If you need `aws-native` or other providers, assume those are global variables too and add a note to me to add that provider. SST also adds global `$` functions for Pulumi helpers, like `$interpolate`. Use those instead of Pulumi helpers.




*/
const domain = "topupanalytics.com";
export default $config({
  app(input) {
    return {
      name: "topupanalytics",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: { command: "1.0.2" },
    };
  },
  async run() {
    const useStripe = process.env.USE_STRIPE === "true"; // Step 1: Read env var
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId;
    const region = aws.getRegionOutput({}).name;
    const partition = aws.getPartitionOutput({}).partition; // Needed for ARN construction
    // Define basename early and use consistently for resource naming
    const basename = `${$app.name}${$app.stage}`;

    const vpc = new sst.aws.Vpc("MyVpc", {
      az: 2
    });

    // === Aurora Database (Postgres Serverless v2) ===
    const database = new sst.aws.Aurora("Database", { // Renamed logical ID for clarity
      engine: "postgres",
      vpc, // Place in VPC
      scaling: {
        min: "0.5 ACU", // Scale to 0 for dev/staging if needed
        max: "4 ACU"
      },
      // Default database name is fine, or specify one: database: `${basename}_db`
    });
    const connectionString = $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${database.database}`;

    // === Database Migration Function ===
    const dbMigrationFn = new sst.aws.Function("DbMigrationFn", {
      handler: "functions/migrations/migrate.handler",
      timeout: "5 minutes", // Longer timeout for migrations
      memory: "1024 MB", // More memory if needed
      architecture: "arm64",
      vpc: vpc, // Run in VPC to access DB
      link: [database], // Link the database
      copyFiles: [{ from: "shared/db/migrations", to: "migrations" }], // Copy migration files
      environment: {
        DB_CONNECTION_STRING: connectionString, // Pass connection string
      },
      nodejs: {
        install: ["drizzle-orm", "postgres", "@neondatabase/serverless"], // Ensure necessary drivers/ORM are installed
      },
    });

    // Trigger migration function on deployment
    new aws.lambda.Invocation("DbMigrationTrigger", {
      functionName: dbMigrationFn.name,
      input: "{}", // Add required empty input payload
      triggers: {
        // Trigger on changes to the function or migration files (using a hash)
        // Also include DB cluster ARN to ensure DB is ready before first invocation
        redeployment: $interpolate`${dbMigrationFn.arn}${database.clusterArn}`,
      },
      // Implicit dependency via triggers ensures this runs after function and DB are ready
    });


    // === Linkable Wrappers (using global sst) ===
    // Wrap Kinesis Firehose Delivery Stream
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: { name: stream.name, arn: stream.arn }, // Include ARN
      include: [
        sst.aws.permission({
          actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [stream.arn],
        }),
      ],
    }));
    // Wrap Glue Catalog Database
    sst.Linkable.wrap(aws.glue.CatalogDatabase, (db) => ({
      properties: { name: db.name, arn: db.arn },
      include: [
        sst.aws.permission({
          actions: ["glue:GetDatabase"],
          resources: [db.arn],
        }),
      ],
    }));
    // Wrap Glue Catalog Table
    sst.Linkable.wrap(aws.glue.CatalogTable, (table) => ({
      properties: {
        name: table.name,
        arn: table.arn,
        databasename: table.databaseName,
      },
      include: [
        sst.aws.permission({
          actions: [
            "glue:GetTable",
            "glue:GetTableVersion",
            "glue:GetTableVersions",
            "glue:GetPartition",
            "glue:GetPartitions",
          ], // Read actions
          resources: [
            table.arn,
            // Use $interpolate for constructing related ARNs
            $interpolate`arn:${partition}:glue:${region}:${accountId}:database/${table.databaseName}`,
            $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
          ],
        }),
      ],
    }));
    const tableNames = ["events", "initial_events"] as const;
    type TableName = (typeof tableNames)[number]; // Define a type for table names
    // === S3 Bucket for Analytics Data ===
    const analyticsDataBucket = new sst.aws.Bucket("AnalyticsDataBucket", {});
    // === S3 Buckets ===
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {});
    // === Common S3 Lifecycle Rule for Intelligent Tiering ===
    const intelligentTieringRule: aws.types.input.s3.BucketLifecycleConfigurationV2Rule[] =
      [
        {
          id: "IntelligentTieringRule",
          status: "Enabled",
          filter: {}, // Apply rule to all objects
          transitions: [
            {
              days: 0,
              storageClass: "INTELLIGENT_TIERING",
            },
          ],
        },
      ];
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
    },);
    // Import schemas for both tables
    const { initialGlueColumns, eventsGlueColumns } = await import(
      "./functions/analytics/schema"
    );
    const glueColumns: Record<
      TableName,
      aws.types.input.glue.CatalogTableStorageDescriptorColumn[]
    > = {
      events: eventsGlueColumns,
      initial_events: initialGlueColumns,
    };
    // Define partition keys once for consistency
    const commonPartitionKeys: aws.types.input.glue.CatalogTablePartitionKey[] =
      [
        { name: "site_id", type: "string" },
        { name: "dt", type: "string" }, // Format like yyyy-MM-dd
      ];
    // Create Glue Tables - Firehose Iceberg destination requires these
    const glueTables = Object.fromEntries(
      tableNames.map((tableName) => {
        const glueTableName = `${basename}_${tableName}`; // Match S3 Table name convention
        return [
          tableName, // Keep original key for mapping
          new aws.glue.CatalogTable(`GlueCatalogTable${tableName}`, {
            name: glueTableName, // Use explicit name
            databaseName: glueCatalogDatabase.name,
            tableType: "EXTERNAL_TABLE", // Required for Iceberg format
            parameters: {
              classification: "iceberg",
            },
            storageDescriptor: {
              location: $interpolate`s3://${analyticsDataBucket.name}/${tableName}/`, // Base path for the table
              columns: glueColumns[tableName], // Schema from import
            },
            partitionKeys: commonPartitionKeys,
            openTableFormatInput: {
              icebergInput: {
                metadataOperation: "CREATE", // Create the table metadata
                version: "2", // Specify Iceberg format version (optional, defaults usually ok)
              },
            },
          }),
        ];
      }),
    ) as Record<TableName, aws.glue.CatalogTable>; // Type assertion
    // === IAM Role for Firehose ===
    const firehoseDeliveryRole = new aws.iam.Role(`FirehoseDeliveryRole`, {
      name: `${basename}-firehose-delivery-role`, // Use explicit, stage-specific name
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "firehose.amazonaws.com",
      }),
    });

    // Allow Firehose to write to S3 (Iceberg & HTTP Backup) and access Glue
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
          },
          {
            "Effect": "Allow",
            "Action": [
                "kinesis:DescribeStream",
                "kinesis:GetShardIterator",
                "kinesis:GetRecords",
                "kinesis:ListShards"
            ],
            "Resource": "*"
          },
          {
            "Effect": "Allow",
            "Action": [
                "kms:Decrypt",
                "kms:GenerateDataKey"
            ],
            "Resource": "*",
            "Condition": {
                "StringEquals": {
                    "kms:ViaService": "kinesis.${region}.amazonaws.com"
                },
                "StringLike": {
                    "kms:EncryptionContext:aws:kinesis:arn": "arn:aws:kinesis:${region}:${accountId}:stream/*"
                }
            }
          }
        ]
      }`,
    });

    // === Kinesis Data Firehose Delivery Streams (S3/Iceberg) ===
    const firehoses = Object.fromEntries(
      tableNames.map((tableName) => {
        const glueTable = glueTables[tableName]; // Get the specific Glue table resource
        const firehoseName = `${basename}-firehose-${tableName}`; // Define name once

        return [
          tableName, // Keep original key for mapping
          new aws.kinesis.FirehoseDeliveryStream(`FirehoseStream${tableName}`, {
            name: firehoseName, // Use explicit, stage-specific name
            destination: "iceberg",
            tags: {
              Environment: $app.stage,
              Project: $app.name,
              Table: tableName,
            },
            icebergConfiguration: {
              roleArn: firehoseDeliveryRole.arn,
              catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
              // --- Buffering Hints (Updated) ---
              bufferingInterval: 900, // Maximize interval
              bufferingSize: 128, // Maximize size
              s3Configuration: {
                roleArn: firehoseDeliveryRole.arn,
                bucketArn: analyticsDataBucket.arn,
                errorOutputPrefix: $interpolate`iceberg-errors/${tableName}/result=!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/!{firehose:random-string}/`,
              },
              destinationTableConfigurations: [{
                  databaseName: glueCatalogDatabase.name,
                  tableName: glueTable.name,
              }],
            },
          }),
        ];
      }),
    ) as Record<TableName, aws.kinesis.FirehoseDeliveryStream>; // Type assertion

    // === Process Ingest Function (Target for HTTP Firehose) ===
    const processIngestFn = new sst.aws.Function("ProcessIngestFn", {
      handler: "functions/analytics/processIngest.handler",
      timeout: "30 second", // Increased timeout
      memory: "512 MB", // Increased memory
      architecture: "arm64",
      url: { cors: true }, // Enable function URL
      vpc: vpc, // Run in VPC
      link: [
        database,
        firehoses.events,
        firehoses.initial_events,
      ],
      environment: {
        DB_CONNECTION_STRING: connectionString,
        // Resource properties (names, ARNs) are available via Resource.* in function code
      },
      // Permissions for linked resources (DB, Firehose) handled by linking
    });

    // === Kinesis Data Firehose Delivery Stream (HTTP Endpoint) ===
    const ingestHttpFirehose = new aws.kinesis.FirehoseDeliveryStream("IngestHttpFirehose", {
      name: `${basename}-firehose-http-ingest`,
      destination: "http_endpoint",
      httpEndpointConfiguration: {
          url: processIngestFn.url, // Target the ProcessIngestFn URL
          name: "ProcessIngestLambda",
          // Buffering settings for HTTP endpoint
          bufferingInterval: 60, // Adjust as needed (e.g., 60 seconds)
          bufferingSize: 5, // Adjust as needed (e.g., 5 MB)
          roleArn: firehoseDeliveryRole.arn, // Reuse the same role
          s3BackupMode: "FailedDataOnly", // Backup only failed records
          s3Configuration: {
              roleArn: firehoseDeliveryRole.arn,
              bucketArn: analyticsDataBucket.arn, // Backup to the main analytics bucket
              // Define a prefix for failed HTTP ingest data
              prefix: "failed-http-ingest/!{timestamp:yyyy/MM/dd}/!{firehose:random-string}/",
              errorOutputPrefix: "failed-http-ingest-errors/result=!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/!{firehose:random-string}/",
              bufferingInterval: 300, // Standard S3 buffering
              bufferingSize: 5,
              compressionFormat: "GZIP", // Compress backups
          },
          requestConfiguration: {
              contentEncoding: "GZIP", // Expect GZIP encoded data from ingestFn
              // commonAttributes: [] // Add common attributes if needed
          },
      },
      tags: {
        Environment: $app.stage,
        Project: $app.name,
        Type: "HTTP-Ingest",
      },
    });


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
          args.accountRecoverySetting = {
            recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
          };
        },
      },
    });
    const userPoolClientSst = userPool.addClient("UserPoolClient", {});

    // Placeholder values instead of sst.Secret.create
    const DUMMY_STRIPE_SECRET_KEY_PLACEHOLDER = "dummy_stripe_secret_key_placeholder";
    const DUMMY_STRIPE_WEBHOOK_SECRET_PLACEHOLDER = "dummy_stripe_webhook_secret_placeholder";
    const DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER = "dummy_stripe_publishable_key_placeholder";
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined; // For frontend

    // === Router for Public Endpoints (Ingest + Dashboard) ===
    const router = new sst.aws.Router("PublicRouter", {
      domain: isProd ? domain : undefined, // Use custom domain in prod
    });

    // === API Functions (Defined before Router/API Gateway attachments) ===
    const ingestFn = new sst.aws.Function("IngestFn", {
      handler: "functions/analytics/ingest.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64",
      url: { cors: true }, // Keep URL enabled, but primary access is via Router route below
      link: [
        ingestHttpFirehose, // Link the NEW HTTP Firehose
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        INGEST_HTTP_FIREHOSE_NAME: ingestHttpFirehose.name, // Pass explicit name
      },
      // Permissions for linked HTTP Firehose handled by linking
    });
    router.route("/api/event", ingestFn.url);

    const queryFn = new sst.aws.Function("QueryFn", { // Renamed logical ID slightly
      handler: "functions/analytics/query.handler",
      timeout: "60 second",
      memory: "512 MB",
      architecture: "arm64",
      vpc: vpc, // Add VPC configuration
      link: [
        database, // Link Aurora DB
        glueCatalogDatabase,
        glueTables.events,
        glueTables.initial_events,
        athenaResultsBucket,
        analyticsDataBucket,
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        DB_CONNECTION_STRING: connectionString, // Add DB connection string
      },
      permissions: [
        // Athena execution permissions
        {
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
          ],
          resources: ["*"],
        },
        // Glue permissions handled by linking
        // S3 permissions for Athena results bucket
        {
          actions: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:GetBucketLocation",
            "s3:DeleteObject",
          ],
          resources: [athenaResultsBucket.arn, $interpolate`${athenaResultsBucket.arn}/*`],
        },
        // S3 permissions for reading analytics data handled by linking analyticsDataBucket
        // DB permissions handled by linking database
      ],
    });
    // === Management API Functions ===
    const sitesFn = new sst.aws.Function("SitesFn", {
      handler: "functions/api/sites.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64",
      vpc: vpc, // Add VPC configuration
      link: [
        database, // Link Aurora DB
        router
      ],
      environment: {
        ROUTER_URL: router.url,
        USE_STRIPE: useStripe.toString(),
        DB_CONNECTION_STRING: connectionString, // Add DB connection string
      },
      nodejs: {
        install: ["ulid"],
      },
    });
    const accountsFn = new sst.aws.Function("AccountsFn", { // Renamed from PreferencesFn
      handler: "functions/api/accounts.handler", // Updated handler path
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64",
      vpc: vpc, // Add VPC configuration
      link: [
        database // Link Aurora DB
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        DB_CONNECTION_STRING: connectionString, // Add DB connection string
      },
      // Permissions for linked DB handled by linking
    });
    // Step 3: Conditional stripeFn
    let stripeFn: sst.aws.Function | undefined;
    if (useStripe) {
      stripeFn = new sst.aws.Function("StripeFn", {
        handler: "functions/api/stripe.handler",
        timeout: "10 second",
        memory: "128 MB",
        architecture: "arm64",
        vpc: vpc, // Add VPC configuration
        link: [
          database, // Link Aurora DB
          STRIPE_SECRET_KEY!,
          STRIPE_WEBHOOK_SECRET!,
        ],
        environment: {
          USE_STRIPE: useStripe.toString(),
          DB_CONNECTION_STRING: connectionString, // Add DB connection string
        },
        // Permissions for linked DB handled by linking
        nodejs: {
          install: ["stripe"],
        },
      });
    }
    // === API Gateway (for Authenticated Endpoints like /api/query) ===
    const api = new sst.aws.ApiGatewayV2("ManagementApi", {
      domain: isProd
        ? { name: `api.${domain}` }
        : undefined,
      cors: {
        allowOrigins: isProd
          ? [`https://${domain}`]
          : ["http://localhost:5173", "http://127.0.0.1:5173"],
        allowCredentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });
    // Define JWT Authorizer
    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClientSst.id],
      },
    });
    // Define common auth config once
    const commonAuth = { auth: { jwt: { authorizer: jwtAuthorizer.id } } };
    // === Management API Routes (Using Function ARNs for explicit definition) ===
    api.route("GET /api/query", queryFn.arn, commonAuth);
    api.route("POST /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("PUT /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("DELETE /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}/script", sitesFn.arn, commonAuth);
    api.route("GET /api/user/account", accountsFn.arn, commonAuth); // Updated route and target
    api.route("PUT /api/user/account", accountsFn.arn, commonAuth); // Updated route and target
    // Step 5: Conditional Stripe API Routes
    if (useStripe && stripeFn) {
      api.route("POST /api/stripe/webhook", stripeFn.arn); // NO auth needed
      api.route("POST /api/stripe/checkout", stripeFn.arn, commonAuth);
      api.route("GET /api/stripe/portal", stripeFn.arn, commonAuth);
    }
    // === Dashboard (React Frontend) ===
    const publicIngestUrl = $interpolate`${router.url}/api/event`; // Define before component

    // Build embed scripts
    new command.local.Command("BuildEmbedScripts", {
      create: $interpolate`npx esbuild ${process.cwd()}/dashboard/embed-script/src/topup-basic.ts ${process.cwd()}/dashboard/embed-script/src/topup-enhanced.ts ${process.cwd()}/dashboard/embed-script/src/topup-full.ts --bundle --format=iife --outdir=${process.cwd()}/dashboard/public --entry-names=[name].min --define:import.meta.env.VITE_PUBLIC_INGEST_URL='"${publicIngestUrl}"'`
    });


    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      router: { instance: router },
      link: [
        api,
        userPool,
        userPoolClientSst,
      ],
      environment: {
        VITE_COGNITO_USER_POOL_ID: userPool.id,
        VITE_COGNITO_CLIENT_ID: userPoolClientSst.id,
        VITE_AWS_REGION: region,
        VITE_API_URL: api.url,
        VITE_APP_URL: router.url,
        VITE_STRIPE_PUBLISHABLE_KEY: useStripe
          ? STRIPE_PUBLISHABLE_KEY!.value
          : DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER,
        VITE_USE_STRIPE: useStripe.toString(),
        VITE_PUBLIC_INGEST_URL: publicIngestUrl,
      },
    });

    // Step 4: Conditional chargeProcessorFn and Cron
    let chargeProcessorFn: sst.aws.Function | undefined;
    if (useStripe) {
      chargeProcessorFn = new sst.aws.Function("ChargeProcessorFn", {
        handler: "functions/billing/chargeProcessor.handler",
        timeout: "60 second",
        memory: "256 MB",
        architecture: "arm64",
        vpc: vpc, // Add VPC configuration
        link: [
          database, // Link Aurora DB
          STRIPE_SECRET_KEY!,
        ],
        environment: {
          USE_STRIPE: useStripe.toString(),
          DB_CONNECTION_STRING: connectionString, // Add DB connection string
        },
        // Permissions for linked DB handled by linking
        nodejs: {
          install: ["stripe"], // Removed dynamodb client
        },
      });
      new sst.aws.Cron("ChargeCron", {
        schedule: "rate(5 minutes)",
        function: chargeProcessorFn.arn,
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
      databaseName: database.database, // Output DB name
      databaseClusterArn: database.clusterArn, // Output DB Cluster ARN
      dbMigrationFunctionName: dbMigrationFn.name,
      processIngestFunctionName: processIngestFn.name,
      ingestHttpFirehoseName: ingestHttpFirehose.name, // Output HTTP Firehose name
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      dataBucketName: analyticsDataBucket.name,
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: firehoses.events.name,
      initialEventsFirehoseStreamName: firehoses.initial_events.name,
      glueDatabaseName: glueCatalogDatabase.name,
      eventsGlueTableName: glueTables.events.name,
      initialEventsGlueTableName: glueTables.initial_events.name,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      isProd,
      routerDistributionId: router.distributionID,
      chargeProcessorFunctionName: chargeProcessorFn?.name,
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined,
      sitesFunctionName: sitesFn?.name,
      accountsFunctionName: accountsFn?.name, // Updated output key
      stripeFunctionName: stripeFn?.name,
    };
  },
});
