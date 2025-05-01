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


    // === Linkable Wrappers (using global sst) ===
    // Wrap Kinesis Firehose Delivery Stream
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: { name: stream.name },
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
    const analyticsDataBucket = new sst.aws.Bucket("AnalyticsDataBucket", {
      // name: `${basename}-analytics-data`, // Explicit name if needed, SST generates one
      // intelligentTiering: true, // ERROR: Not a valid property here. Apply lifecycle rule below.
    });
    // === S3 Buckets ===
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {
      // name: `${basename}-athena-results`, // Use explicit, stage-specific name
    });
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
      // Point location to a logical path within the S3 Table Bucket for organization
      // locationUri is not typically needed for Glue DB, especially with Iceberg tables managing their own locations.
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
              // @worked-before: Now it says "Cannot use reserved parameters table_type while creating an iceberg tble"
              // table_type: "ICEBERG", // Identify as Iceberg
              // @terraform-example - excluded
              classification: "iceberg", // Can also be parquet if Firehose converts first
              // @terraform-example - included
              // format: "parquet",
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
              // compressed: true, // Compression handled by Parquet/Iceberg writers
              // storedAsSubDirectories: true, // Iceberg manages its own directory structure
            },
            // Define partition keys so Firehose & Iceberg know how to physically
            // lay out the data. This must match the dynamicPartitioning keys
            // we extract (site_id & dt).
            // @worked-before: "Cannot create partitions in an iceberg table"
            // partitionKeys: commonPartitionKeys,
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

    /*
    Sample FirehoseDeliveryStream for HTTP. Wire it to an sst.aws.Function(..., {url: true}).url,
    and just use one Firehose for the "just pass along" (the two below will remain for the
    separate S3 buckets).

    const testStream = new aws.kinesis.FirehoseDeliveryStream("test_stream", {
      name: "kinesis-firehose-test-stream",
      destination: "http_endpoint",
      httpEndpointConfiguration: {
          url: "https://aws-api.newrelic.com/firehose/v1",
          name: "New Relic",
          accessKey: "my-key",
          bufferingSize: 15,
          bufferingInterval: 600,
          roleArn: firehose.arn,
          s3BackupMode: "FailedDataOnly",
          s3Configuration: {
              roleArn: firehose.arn,
              bucketArn: bucket.arn,
              bufferingSize: 10,
              bufferingInterval: 400,
              compressionFormat: "GZIP",
          },
          requestConfiguration: {
              contentEncoding: "GZIP",
              commonAttributes: [
                  {
                      name: "testname",
                      value: "testvalue",
                  },
                  {
                      name: "testname2",
                      value: "testvalue2",
                  },
              ],
          },
      },
  });
     */

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
    // === Kinesis Data Firehose Delivery Streams ===
    const firehoses = Object.fromEntries(
      tableNames.map((tableName) => {
        const glueTable = glueTables[tableName]; // Get the specific Glue table resource
        const firehoseName = `${basename}-firehose-${tableName}`; // Define name once

        return [
          tableName, // Keep original key for mapping
          new aws.kinesis.FirehoseDeliveryStream(`FirehoseStream${tableName}`, {
            name: firehoseName, // Use explicit, stage-specific name
            // --- Key Change: Specify 'iceberg' destination ---
            destination: "iceberg",
            tags: {
              Environment: $app.stage,
              Project: $app.name,
              Table: tableName,
            },

            // --- Use 'icebergConfiguration' based on the example ---
            icebergConfiguration: {
              roleArn: firehoseDeliveryRole.arn, // Role Firehose assumes for access

              // --- Catalog Identification using ARN (as per example) ---
              catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,

              // --- Buffering Hints (Directly under icebergConfiguration) ---
              bufferingInterval: 60, // Seconds (e.g., 60-900)
              bufferingSize: 64, // MBs (e.g., 64-128)

              // --- S3 Configuration (Nested) ---
              // @terraform-example - entire s3Configuration section  excluded
              // https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_firehose_delivery_stream#iceberg-destination
              s3Configuration: {
                // Role ARN seems required here too, even if same as top-level
                roleArn: firehoseDeliveryRole.arn,
                bucketArn: analyticsDataBucket.arn, // Bucket where Iceberg data/metadata resides

                // CloudWatch logging (Remains inside s3Configuration)
                // cloudwatchLoggingOptions: {
                //   enabled: true,
                //   logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseName}`, // Use consistent naming
                //   logStreamName: "IcebergDelivery", // Specific stream name
                // },

                // Error output (Remains inside s3Configuration)
                // Using a pattern similar to the example's error structure
                errorOutputPrefix: $interpolate`iceberg-errors/${tableName}/result=!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/!{firehose:random-string}/`,
              },

              // --- Destination Table Config (as per example) ---
              // Defines the specific Glue database and table target
              destinationTableConfigurations: [{
                  databaseName: glueCatalogDatabase.name,
                  tableName: glueTable.name,
              }],
            },
          }),
        ];
      }),
    ) as Record<TableName, aws.kinesis.FirehoseDeliveryStream>; // Type assertion

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
    const userPoolClientSst = userPool.addClient("UserPoolClient", {
      // name: `${basename}-web-client`, // Explicit name
    });

    // Placeholder values instead of sst.Secret.create
    const DUMMY_STRIPE_SECRET_KEY_PLACEHOLDER = "dummy_stripe_secret_key_placeholder";
    const DUMMY_STRIPE_WEBHOOK_SECRET_PLACEHOLDER = "dummy_stripe_webhook_secret_placeholder";
    const DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER = "dummy_stripe_publishable_key_placeholder";
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined; // For frontend

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      fields: {
        site_id: "string",
        owner_sub: "string",
        plan: "string",
      },
      primaryIndex: { hashKey: "site_id" },
      globalIndexes: {
        ownerSubIndex: { hashKey: "owner_sub", projection: ["site_id"] },
        planIndex: { hashKey: "plan", projection: "all" },
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      fields: {
        cognito_sub: "string",
      },
      primaryIndex: { hashKey: "cognito_sub" },
    });
    // === Router for Public Endpoints (Ingest + Dashboard) ===
    const router = new sst.aws.Router("PublicRouter", {
      domain: isProd ? {
        name: domain,
        redirects: [`www.${domain}`],
      } : undefined,
    });

    // === Consolidated Management API Function ===
    const mainApiFn = new sst.aws.Function("mainApiFn", {
      handler: "functions/api/main.handler", // New handler location
      timeout: "60 second", // Max timeout from merged functions
      memory: "512 MB", // Max memory from merged functions
      architecture: "arm64", // Consistent architecture
      link: [
        // Merged links
        glueCatalogDatabase,
        glueTables.events,
        glueTables.initial_events,
        athenaResultsBucket,
        analyticsDataBucket,
        sitesTable,
        userPreferencesTable,
        router, // For ROUTER_URL env var
        // Conditional Stripe links
        ...(useStripe ? [STRIPE_SECRET_KEY!, STRIPE_WEBHOOK_SECRET!] : []),
      ],
      environment: {
        // Merged environment variables
        USE_STRIPE: useStripe.toString(),
        ROUTER_URL: router.url,
      },
      permissions: [
        // Primarily Athena permissions from original queryFn
        {
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
          ],
          resources: ["*"],
        },
        // S3 permissions for Athena results bucket (kept for clarity)
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
        // Other permissions (Glue, DynamoDB, S3 analytics) are handled by linking
      ]
    });

    // === Stripe Webhook Function (Conditional) ===
    let stripeFn: sst.aws.Function | undefined;
    if (useStripe) {
      // Keep stripeFn definition ONLY for the webhook if useStripe is true
      stripeFn = new sst.aws.Function("StripeFn", {
        handler: "functions/api/stripe.handler", // Handler remains the same, but will only receive webhook events
        timeout: "10 second", // Original timeout
        memory: "128 MB", // Original memory
        architecture: "arm64", // Original architecture
        link: [
          // ONLY link the webhook secret, as this function now *only* handles the webhook
          STRIPE_WEBHOOK_SECRET!,
        ],
        environment: {
          // Only need the USE_STRIPE flag if the handler logic depends on it
          USE_STRIPE: useStripe.toString(),
        },
        nodejs: {
          // Still need the stripe SDK for webhook verification/handling
          install: ["stripe"],
        },
        // No explicit permissions needed beyond what linking provides for the secret
      });
    }

    // === API Gateway (for Authenticated Endpoints) ===
    const api = new sst.aws.ApiGatewayV2("ManagementApi", {
      // cors: true
      cors: {
        allowOrigins: isProd
          ? [`https://${domain}`]
          : ["http://localhost:5173"],
        allowCredentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allow necessary methods
        allowHeaders: ["*"], // Allow standard headers + Auth
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
    // Define common auth config
    const commonAuth = { auth: { jwt: { authorizer: jwtAuthorizer.id } } };

    // === Management API Routes (Consolidated) ===
    api.route("GET /api/query", mainApiFn.arn, commonAuth);
    api.route("POST /api/sites", mainApiFn.arn, commonAuth);
    api.route("GET /api/sites", mainApiFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}", mainApiFn.arn, commonAuth);
    api.route("PUT /api/sites/{site_id}", mainApiFn.arn, commonAuth);
    api.route("DELETE /api/sites/{site_id}", mainApiFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}/script", mainApiFn.arn, commonAuth);
    api.route("GET /api/user/preferences", mainApiFn.arn, commonAuth);
    api.route("PUT /api/user/preferences", mainApiFn.arn, commonAuth);
    // Step 5: Conditional Stripe API Routes
    if (useStripe && stripeFn) {
      // Check stripeFn exists
      api.route("POST /api/stripe/webhook", stripeFn.arn); // NO auth needed
      api.route("POST /api/stripe/checkout", mainApiFn.arn, commonAuth); // Requires JWT auth
      api.route("GET /api/stripe/portal", mainApiFn.arn, commonAuth); // Add portal route
    }
    router.route("/api/*", api.url)

    // === Dashboard (React Frontend) ===
    const publicIngestUrl = $interpolate`${router.url}/api/event`;

    // Build into public, which gets transfered too on deploy. This so we can test in dev
    // mode easily; don't need 2 vite build strategies (one for dev->public, deploy->dist)
    const buildEmbedScripts = new command.local.Command("BuildEmbedScripts", {
      create: $interpolate`npx esbuild ${process.cwd()}/dashboard/embed-script/src/topup-basic.ts ${process.cwd()}/dashboard/embed-script/src/topup-enhanced.ts ${process.cwd()}/dashboard/embed-script/src/topup-full.ts --bundle --format=iife --outdir=${process.cwd()}/dashboard/public --entry-names=[name].min --define:import.meta.env.VITE_PUBLIC_INGEST_URL='"${publicIngestUrl}"'`
    });

    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      router: {
        instance: router,
        path: "/"
      },
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
    }, {dependsOn: [buildEmbedScripts]});

    // === Billing Charge Processor (Conditional) ===
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
        },
        nodejs: {
          install: ["stripe", "@aws-sdk/client-dynamodb"],
        },
      });
      new sst.aws.Cron("ChargeCron", {
        schedule: "rate(5 minutes)",
        function: chargeProcessorFn.arn,
      });
    }

    // === Ingest Function (Remains Separate) ===
    const ingestFn = new sst.aws.Function("IngestFn", {
      handler: "functions/analytics/ingest.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64",
      url: {
        cors: true,
        router: {
          instance: router,
          path: "/api/event" // Expose via router at /api/event
        }
      },
      link: [
        firehoses.events,
        firehoses.initial_events,
        sitesTable,
        userPreferencesTable,
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
      },
    });

    // === Outputs (Updated) ===
    return {
      appName: $app.name,
      stage: $app.stage,
      accountId: accountId,
      region: region,
      dashboardUrl: router.url,
      managementApiUrl: api.url,
      publicIngestUrl: publicIngestUrl,
      ingestFunctionName: ingestFn.name,
      // Removed: queryFunctionName, sitesFunctionName, preferencesFunctionName
      mainApiFunctionName: mainApiFn.name, // Added
      stripeFunctionName: stripeFn?.name, // Kept (might be undefined)
      dataBucketName: analyticsDataBucket.name,
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: firehoses.events.name,
      initialEventsFirehoseStreamName: firehoses.initial_events.name,
      glueDatabaseName: glueCatalogDatabase.name,
      eventsGlueTableName: glueTables.events.name,
      initialEventsGlueTableName: glueTables.initial_events.name,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      routerDistributionId: router.distributionID,
      chargeProcessorFunctionName: chargeProcessorFn?.name,
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined,
    };
  },
});
