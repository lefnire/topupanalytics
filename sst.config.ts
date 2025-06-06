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
    // Read .env variables for local prod testing
    const useProdResourcesLocally = $app.stage === 'lefnire' && process.env.USE_PROD_RESOURCES_LOCALLY === "true";
    const prodApiUrl = process.env.PROD_API_URL;
    const prodUserPoolId = process.env.PROD_COGNITO_USER_POOL_ID;
    const prodClientId = process.env.PROD_COGNITO_CLIENT_ID;
    const prodAppUrl = process.env.PROD_APP_URL;
    const prodStripePubKey = process.env.PROD_STRIPE_PUBLISHABLE_KEY;
    const prodPublicIngestUrl = prodAppUrl ? `${prodAppUrl}/api/event` : undefined; // Construct prod ingest URL

    // Optional validation (as per plan)
    if (useProdResourcesLocally && (!prodApiUrl || !prodUserPoolId || !prodClientId || !prodAppUrl)) {
      console.warn("WARN: USE_PROD_RESOURCES_LOCALLY is true, but one or more PROD_* environment variables are missing in .env. Frontend might not connect correctly.");
    }

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
        name: `${basename}_events`, // Use explicit name, underscores only
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
    // Lake Formation is not required for this standard S3/Glue/Firehose setup.
    // Standard IAM permissions on the Firehose role are sufficient.
    // === Kinesis Data Firehose Delivery Streams ===
    // Configure destination: "extended_s3" with data format conversion and dynamic partitioning
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
      // transform can be used here if needed for specific client settings
      // transform: { client: (args) => { ... }}
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
      // name: `${basename}-sites`, // Explicit name
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
      // name: `${basename}-user-preferences`, // Explicit name
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
        // Add DNS config if needed: dns: sst.aws.dns({ zone: "YOUR_ZONE_ID" })
      } : undefined,
    });

    const queryFn = new sst.aws.Function("QueryFn", {
      handler: "functions/analytics/query.handler",
      timeout: "60 second",
      memory: "512 MB",
      architecture: "arm64", // Use ARM
      // NOTE: queryFn is NOT attached to the public Router
      link: [
        glueCatalogDatabase, // Link DB
        glueTables.events, // Link events Glue Table
        glueTables.initial_events, // Link initial_events Glue Table
        athenaResultsBucket, // Link results bucket
        analyticsDataBucket, // Link the data bucket
        sitesTable,
        userPreferencesTable,
      ],
      environment: {
        // Resource properties (names, ARNs) are available via Resource.* in function code
        USE_STRIPE: useStripe.toString(),
      },
      permissions: [
        // Athena execution permissions (cannot be fully handled by linking specific resources)
        {
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
          ],
          resources: ["*"],
        },
        // Glue permissions are handled by linking Glue DB/Tables
        // S3 permissions for Athena results bucket (Keep explicit as linking might not cover all Athena/S3 nuances)
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
      },
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
          sitesTable, // Link for subscription ID/plan update
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
        },
      });
    }
    // === API Gateway (for Authenticated Endpoints like /api/query) ===
    const api = new sst.aws.ApiGatewayV2("ManagementApi", {
      cors: {
        allowOrigins: isProd
          ? [`https://${domain}`, "http://localhost:5173", "http://127.0.0.1:5173"] // ADD localhost for prod
          : ["http://localhost:5173", "http://127.0.0.1:5173"],
        allowCredentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
      // TODO add transform for gzip
    });
    // Define JWT Authorizer (Using SST User Pool and Client)
    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClientSst.id], // Use the ID from the SST client object
      },
    });
    // Define common auth config once
    const commonAuth = { auth: { jwt: { authorizer: jwtAuthorizer.id } } };
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
    if (useStripe && stripeFn) {
      // Check stripeFn exists
      api.route("POST /api/stripe/webhook", stripeFn.arn); // NO auth needed
      api.route("POST /api/stripe/checkout", stripeFn.arn, commonAuth); // Requires JWT auth
      api.route("GET /api/stripe/portal", stripeFn.arn, commonAuth); // Add portal route
    }
    router.route("/api/*", api.url)
    // === Dashboard (React Frontend) ===
    const publicIngestUrl = $interpolate`${router.url}/api/event`; // Define before component

    // Build into public, which gets transfered too on deploy. This so we can test in dev
    // mode easily; don't need 2 vite build strategies (one for dev->public, deploy->dist)
    const buildEmbedScripts = new command.local.Command("BuildEmbedScripts", {
      // Keep running from root, but use absolute paths for input files
      create: $interpolate`npx esbuild ${process.cwd()}/dashboard/embed-script/src/topup-basic.ts ${process.cwd()}/dashboard/embed-script/src/topup-enhanced.ts ${process.cwd()}/dashboard/embed-script/src/topup-full.ts --bundle --format=iife --outdir=${process.cwd()}/dashboard/public --entry-names=[name].min --define:import.meta.env.VITE_PUBLIC_INGEST_URL='"${publicIngestUrl}"'`
    });


    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      // Attach dashboard to the root of the public Router
      router: {
        instance: router,
        path: "/"
        // path defaults to "/*" when attaching a site like this
      },
      link: [
        api,
        userPool, // Link the SST UserPool component
        userPoolClientSst, // Link the SST UserPoolClient object
      ],
      environment: {
        VITE_COGNITO_USER_POOL_ID: useProdResourcesLocally && prodUserPoolId ? prodUserPoolId : userPool.id,
        VITE_COGNITO_CLIENT_ID: useProdResourcesLocally && prodClientId ? prodClientId : userPoolClientSst.id,
        VITE_AWS_REGION: region,
        VITE_API_URL: useProdResourcesLocally && prodApiUrl ? prodApiUrl : api.url,
        VITE_APP_URL: useProdResourcesLocally && prodAppUrl ? prodAppUrl : router.url,
        VITE_STRIPE_PUBLISHABLE_KEY: useStripe
          ? (useProdResourcesLocally && prodStripePubKey ? prodStripePubKey : STRIPE_PUBLISHABLE_KEY!.value)
          : DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER,
        VITE_USE_STRIPE: useStripe.toString(),
        VITE_PUBLIC_INGEST_URL: useProdResourcesLocally && prodPublicIngestUrl ? prodPublicIngestUrl : publicIngestUrl,
      },
    }, {dependsOn: [buildEmbedScripts]});
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
        },
      });
      new sst.aws.Cron("ChargeCron", {
        schedule: "rate(5 minutes)", // Adjust schedule as needed
        function: chargeProcessorFn.arn, // Trigger the charge processor function ARN
      });
    }

    // === API Functions (Defined before Router/API Gateway attachments) ===
    // Comes last for the /api/event override
    const ingestFn = new sst.aws.Function("IngestFn", {
      handler: "functions/analytics/ingest.handler",
      timeout: "10 second",
      memory: "128 MB",
      architecture: "arm64", // Use ARM
      // Keep URL enabled, but primary access is via Router route below
      url: {
        cors: true, // Keep direct Function URL enabled with CORS if needed
        router: { // Integrate with the router
          instance: router,
          path: "/api/event" // Expose this function at /api/events via the router
        }
      },
      link: [
        firehoses.events,
        firehoses.initial_events,
        sitesTable,
        userPreferencesTable, // Link the user preferences table
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        // Resource properties (names, ARNs) are available via Resource.* in function code
      },
      permissions: [
        // Permissions for linked resources (Firehose, DynamoDB) are handled by linking
      ],
    });
    // router.route("/api/event", ingestFn.url);

// === IAM Role for Glue Iceberg Optimization ===
    const glueIcebergOptimizerRole = new aws.iam.Role(`GlueIcebergOptimizerRole`, {
      name: $interpolate`${basename}-glue-iceberg-optimizer-role`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "glue.amazonaws.com",
      }),
    });

    new aws.iam.RolePolicy(`GlueIcebergOptimizerMainPolicy`, {
      role: glueIcebergOptimizerRole.id,
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "s3:PutObject",
              "s3:GetObject",
              "s3:DeleteObject"
            ],
            "Resource": [
              "${analyticsDataBucket.arn}/*"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [
              "s3:ListBucket"
            ],
            "Resource": [
              "${analyticsDataBucket.arn}"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [
              "glue:UpdateTable",
              "glue:GetTable"
            ],
            "Resource": [
              "arn:${partition}:glue:${region}:${accountId}:table/*/*",
              "arn:${partition}:glue:${region}:${accountId}:database/*",
              "arn:${partition}:glue:${region}:${accountId}:catalog"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents"
            ],
            "Resource": [
              "arn:${partition}:logs:${region}:${accountId}:log-group:/aws-glue/iceberg-compaction/logs:*",
              "arn:${partition}:logs:${region}:${accountId}:log-group:/aws-glue/iceberg-retention/logs:*",
              "arn:${partition}:logs:${region}:${accountId}:log-group:/aws-glue/iceberg-orphan-file-deletion/logs:*"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [
                "lakeformation:GetDataAccess"
            ],
            "Resource": "*"
          }
        ]
      }`,
    });

    new aws.iam.RolePolicy(`GlueIcebergOptimizerPassRolePolicy`, {
      role: glueIcebergOptimizerRole.id,
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "${glueIcebergOptimizerRole.arn}"
          }
        ]
      }`,
    });
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
      glueIcebergOptimizerRoleArn: glueIcebergOptimizerRole.arn,
      // tableBucketArn: s3Table.tableBucketArn,
      // warehouseLocation: s3Table.warehouseLocation,
    productionEnvValues: isProd ? {
      PROD_API_URL: api.url,
      PROD_COGNITO_USER_POOL_ID: userPool.id,
      PROD_COGNITO_CLIENT_ID: userPoolClientSst.id,
      PROD_APP_URL: router.url,
      PROD_STRIPE_PUBLISHABLE_KEY: useStripe ? STRIPE_PUBLISHABLE_KEY?.value : "N/A (Stripe not enabled)",
      // Add any other relevant prod values here if needed
    } : undefined, // Only include this block for production stage
  };
  },
});
