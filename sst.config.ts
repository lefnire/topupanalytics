/// <reference path="./.sst/platform/config.d.ts" />
/*
## Instructions
This uses SST v3, which uses Pulumi under the hood - not CDK (SST v2). SST v3 adds a global variable `aws`, which is an augmented version of the `aws` you'd import from Pulumi. Never try to add imports to this file, always use the global `aws`, and assume it has what you'd need from Pulumi. If you need `aws-native` or other providers, assume those are global variables too and add a note to me to add that provider. SST also adds global `$` functions for Pulumi helpers, like `$interpolate`. Use those instead of Pulumi helpers.
*/

/*
====================================================================================================
MANDATORY PREREQUISITE: Enable S3 Tables Integration in AWS
====================================================================================================

**CRITICAL: Before deploying this stack, you must perform a one-time manual setup in the AWS
Management Console for the target AWS Region.**

This stack provisions an AWS Kinesis Firehose stream to deliver data into an S3 Table (Iceberg
format). This requires a foundational integration between Amazon S3, AWS Glue, and AWS Lake
Formation, which must be enabled manually.

----------------------------------------------------------------------------------------------------
Instructions (Perform ONCE PER AWS REGION):
----------------------------------------------------------------------------------------------------
1.  Navigate to the Amazon S3 console.
2.  In the left navigation, click on "S3 Tables".
3.  Click the button to "Enable integration with AWS analytics services" (or similar wording).

This manual step creates the `s3tablescatalog` in AWS Glue and the necessary service-linked IAM
role for Lake Formation. This stack depends on these resources. Failure to complete this step will
result in deployment errors, typically "Catalog not found" or Lake Formation permission issues.

For more details, see the official AWS documentation:
https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html

----------------------------------------------------------------------------------------------------
What this Stack Automates:
----------------------------------------------------------------------------------------------------
Once the prerequisite is met, this script automates the creation of:
*   The S3 Table, Namespace, and underlying bucket.
*   A Kinesis Firehose delivery stream targeting the S3 Table.
*   A backup S3 bucket for Firehose.
*   The necessary IAM Role and granular permissions for Firehose.
*   A Glue Resource Link to bridge the default catalog with the `s3tablescatalog`.
*   Specific Lake Formation permissions for the Firehose role to access the S3 Table.
====================================================================================================
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
    // const useProdResourcesLocally = $app.stage === 'lefnire' && process.env.USE_PROD_RESOURCES_LOCALLY === "true";
    const useProdResourcesLocally = false;
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

    const tableNames = ["events", "initial_events"] as const;
    type TableName = (typeof tableNames)[number]; // Define a type for table names

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
    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`AthenaResultsBucketLifecycle`, {
      bucket: athenaResultsBucket.name, // Reference the explicit name
      rules: intelligentTieringRule,
    });

    // ============================================================================================
    // === S3 TABLES MIGRATION: New Analytics Infrastructure
    // ============================================================================================

    const s3TableBucketName = `${basename}-s3-table-bucket`.toLowerCase();
    const s3TableNamespaceName = "firehose_data_ns"; // Keep underscores, good for Glue
    const firehoseBackupBucketName = `${basename}-firehose-backup`.toLowerCase();
    const firehoseResourceLinkName = `${basename.replace(/-/g, "_")}_s3table_ns_link`;

    // 1. Foundational S3 Table Resources
    const analyticsS3TableBucket = new aws.s3tables.TableBucket("AnalyticsS3TableBucket", {
      name: s3TableBucketName,
    });

    const analyticsS3TableNamespace = new aws.s3tables.Namespace("AnalyticsS3TableNamespace", {
      namespace: s3TableNamespaceName,
      tableBucketArn: analyticsS3TableBucket.arn,
    });

    const s3TableSchemas = {
      events: [
        { name: "site_id", type: "string", required: true },
        { name: "dt", type: "string", required: true },
        { name: "event", type: "string", required: true },
        { name: "pathname", type: "string" },
        { name: "session_id", type: "string" },
        { name: "timestamp", type: "timestamp", required: true },
        { name: "properties", type: "string" },
      ],
      initial_events: [
        // common
        { name: "site_id", type: "string", required: true },
        { name: "dt", type: "string", required: true },
        { name: "event", type: "string", required: true },
        { name: "pathname", type: "string" },
        { name: "session_id", type: "string" },
        { name: "timestamp", type: "timestamp", required: true },
        { name: "properties", type: "string" },
        // initial only
        { name: "distinct_id", type: "string" },
        { name: "model", type: "string" },
        { name: "manufacturer", type: "string" },
        { name: "city", type: "string" },
        { name: "timezone", type: "string" },
        { name: "browser_version", type: "string" },
        { name: "os_version", type: "string" },
        { name: "screen_height", type: "string" },
        { name: "screen_width", type: "string" },
        { name: "region", type: "string" },
        { name: "country", type: "string" },
        { name: "device", type: "string" },
        { name: "browser", type: "string" },
        { name: "os", type: "string" },
        { name: "referer", type: "string" },
        { name: "referer_domain", type: "string" },
        { name: "utm_source", type: "string" },
        { name: "utm_campaign", type: "string" },
        { name: "utm_medium", type: "string" },
        { name: "utm_content", type: "string" },
        { name: "utm_term", type: "string" },
      ],
    };

    const s3TableCommands = Object.fromEntries(
      tableNames.map((tableName) => {
        const schemaFields = s3TableSchemas[tableName as TableName];
        const tableInput = {
          tableBucketARN: analyticsS3TableBucket.arn,
          namespace: analyticsS3TableNamespace.namespace,
          name: tableName,
          format: "ICEBERG",
          metadata: {
            iceberg: {
              schema: {
                fields: schemaFields,
              },
            },
          },
        };
        const tableInputJson = $jsonStringify(tableInput);

        const tableCommand = new command.local.Command(`AnalyticsS3Table_${tableName}`, {
          create: $interpolate`aws s3tables create-table --cli-input-json '${tableInputJson}'`,
          delete: $interpolate`aws s3tables delete-table --table-bucket-arn ${analyticsS3TableBucket.arn} --namespace ${analyticsS3TableNamespace.namespace} --table-name ${tableName}`,
        }, { dependsOn: [analyticsS3TableBucket, analyticsS3TableNamespace] });

        return [tableName, tableCommand];
      })
    ) as Record<TableName, command.local.Command>;

    const s3Tables = Object.fromEntries(
      tableNames.map((tableName) => [
        tableName,
        { name: $interpolate`${tableName}` },
      ])
    );

    // 2. Standard S3 Bucket for Firehose Backups
    const firehoseBackupBucket = new sst.aws.Bucket("FirehoseBackupBucket", {
      transform: {
        bucket: (args) => {
          args.bucket = firehoseBackupBucketName;
        },
      },
    });

    // 3. IAM Role and Policy for Kinesis Firehose
    const firehoseS3TablesRole = new aws.iam.Role("FirehoseS3TablesRole", {
      name: `${basename}-FirehoseS3TablesRole`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "firehose.amazonaws.com",
      }),
    });

    const firehosePolicyDocument = aws.iam.getPolicyDocumentOutput({
        statements: [
          {
            sid: "GlueAccessForS3TablesAndResourceLink",
            effect: "Allow",
            actions: [
              "glue:GetTable", "glue:GetTables", "glue:GetDatabase", "glue:GetDatabases",
              "glue:CreateTable", "glue:UpdateTable",
            ],
            resources: [
              $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:database/${firehoseResourceLinkName}`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:table/${firehoseResourceLinkName}/*`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog/s3tablescatalog`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog/s3tablescatalog/*`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:database/*`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:table/*/*`,
            ],
          },
          {
            sid: "S3DeliveryErrorBucketPermission",
            effect: "Allow",
            actions: [
              "s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject",
              "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject",
            ],
            resources: [
              firehoseBackupBucket.arn,
              $interpolate`${firehoseBackupBucket.arn}/*`,
            ],
          },
          {
            sid: "RequiredWhenDoingMetadataReadsANDDataAndMetadataWriteViaLakeformation",
            effect: "Allow",
            actions: ["lakeformation:GetDataAccess"],
            resources: ["*"],
          },
        ],
    });

    const firehoseS3TablesPolicy = new aws.iam.Policy("FirehoseS3TablesPolicy", {
      name: `${basename}-FirehoseS3TablesPolicy`,
      policy: firehosePolicyDocument.json,
    });

    new aws.iam.RolePolicyAttachment("FirehoseS3TablesRolePolicyAttachment", {
      role: firehoseS3TablesRole.name,
      policyArn: firehoseS3TablesPolicy.arn,
    });

    // 4. Glue Resource Link to the S3 Table Namespace (via AWS CLI)
    const s3TableNamespaceLink = new command.local.Command("S3TableNamespaceLink", {
      create: $interpolate`aws glue create-database --database-input '{
        "Name": "${firehoseResourceLinkName}",
        "TargetDatabase": {
          "CatalogId": "${accountId}:s3tablescatalog/${analyticsS3TableBucket.name}",
          "DatabaseName": "${analyticsS3TableNamespace.namespace}"
        }
      }'`,
      delete: $interpolate`aws glue delete-database --name ${firehoseResourceLinkName}`,
    }, { dependsOn: [analyticsS3TableBucket, analyticsS3TableNamespace] });

    // 5. Lake Formation Permissions (via AWS CLI)
    const lfPermDb = new command.local.Command("LfPermDb", {
        create: $interpolate`aws lakeformation grant-permissions --principal '{"DataLakePrincipalIdentifier": "${firehoseS3TablesRole.arn}"}' --permissions '["DESCRIBE", "ALTER", "CREATE_TABLE"]' --resource '{
        "Database": {
          "CatalogId": "${accountId}:s3tablescatalog/${analyticsS3TableBucket.name}",
          "Name": "${analyticsS3TableNamespace.namespace}"
        }
      }'`,
        delete: $interpolate`aws lakeformation revoke-permissions --principal '{"DataLakePrincipalIdentifier": "${firehoseS3TablesRole.arn}"}' --permissions '["DESCRIBE", "ALTER", "CREATE_TABLE"]' --resource '{
        "Database": {
          "CatalogId": "${accountId}:s3tablescatalog/${analyticsS3TableBucket.name}",
          "Name": "${analyticsS3TableNamespace.namespace}"
        }
      }'`,
    }, { dependsOn: [firehoseS3TablesRole, analyticsS3TableNamespace, analyticsS3TableBucket] });

    const lfPermDbLink = new command.local.Command("LfPermDbLink", {
        create: $interpolate`aws lakeformation grant-permissions --principal '{"DataLakePrincipalIdentifier": "${firehoseS3TablesRole.arn}"}' --permissions '["DESCRIBE"]' --resource '{
        "Database": {
          "CatalogId": "${accountId}",
          "Name": "${firehoseResourceLinkName}"
        }
      }'`,
        delete: $interpolate`aws lakeformation revoke-permissions --principal '{"DataLakePrincipalIdentifier": "${firehoseS3TablesRole.arn}"}' --permissions '["DESCRIBE"]' --resource '{
        "Database": {
          "CatalogId": "${accountId}",
          "Name": "${firehoseResourceLinkName}"
        }
      }'`,
    }, { dependsOn: [firehoseS3TablesRole, s3TableNamespaceLink] });

    const lfPermsTableLink = tableNames.map(tableName => new command.local.Command(`LfPermTableLink_${tableName}`, {
        create: $interpolate`aws lakeformation grant-permissions --principal '{"DataLakePrincipalIdentifier": "${firehoseS3TablesRole.arn}"}' --permissions '["ALL"]' --resource '{
        "Table": {
          "CatalogId": "${accountId}",
          "DatabaseName": "${firehoseResourceLinkName}",
          "Name": "${s3Tables[tableName].name}"
        }
      }'`,
        delete: $interpolate`aws lakeformation revoke-permissions --principal '{"DataLakePrincipalIdentifier": "${firehoseS3TablesRole.arn}"}' --permissions '["ALL"]' --resource '{
        "Table": {
          "CatalogId": "${accountId}",
          "DatabaseName": "${firehoseResourceLinkName}",
          "Name": "${s3Tables[tableName].name}"
        }
      }'`,
    }, { dependsOn: [firehoseS3TablesRole, s3TableCommands[tableName as TableName], lfPermDbLink] }));


    // 6. Kinesis Data Firehose Delivery Streams
    const firehoses = Object.fromEntries(
      tableNames.map((tableName) => {
        const firehoseName = `${basename}-firehose-${tableName}-s3t`; // Renamed to force replacement
        return [
          tableName,
          new aws.kinesis.FirehoseDeliveryStream(`FirehoseStream_${tableName}`, {
            name: firehoseName,
            destination: "iceberg",
            icebergConfiguration: {
              roleArn: firehoseS3TablesRole.arn,
              catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
              s3Configuration: {
                roleArn: firehoseS3TablesRole.arn,
                bucketArn: firehoseBackupBucket.arn,
                bufferingInterval: 60,
                bufferingSize: 5,
                cloudwatchLoggingOptions: {
                  enabled: true,
                  logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseName}-backupS3`,
                  logStreamName: "S3Delivery",
                }
              },
              destinationTableConfigurations: [{
                databaseName: firehoseResourceLinkName,
                tableName: s3Tables[tableName].name,
              }],
            },
          }, { dependsOn: [...lfPermsTableLink, s3TableNamespaceLink, lfPermDbLink] }),
        ];
      }),
    ) as Record<TableName, aws.kinesis.FirehoseDeliveryStream>;



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
        athenaResultsBucket, // Link results bucket
        analyticsS3TableBucket, // Link the S3 Table data bucket
        sitesTable,
        userPreferencesTable,
      ],
      environment: {
        USE_STRIPE: useStripe.toString(),
        GLUE_RESOURCE_LINK_NAME: firehoseResourceLinkName,
        EVENTS_TABLE_NAME: s3Tables.events.name,
        INITIAL_EVENTS_TABLE_NAME: s3Tables.initial_events.name,
        S3_TABLE_BUCKET_NAME: analyticsS3TableBucket.name,
        S3_TABLE_NAMESPACE_NAME: analyticsS3TableNamespace.namespace,
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
        // Explicit Glue permissions needed for Athena to query S3 tables via resource link
        {
          actions: [
            "glue:GetDatabase",
            "glue:GetDatabases",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartition",
            "glue:GetPartitions",
            "glue:BatchGetPartition",
          ],
          resources: [
            $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
            $interpolate`arn:${partition}:glue:${region}:${accountId}:database/${firehoseResourceLinkName}`,
            $interpolate`arn:${partition}:glue:${region}:${accountId}:table/${firehoseResourceLinkName}/*`,
            // Also need access to the s3tablescatalog itself
            $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog/s3tablescatalog`,
            $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog/s3tablescatalog/*`,
          ],
        },
        {
          actions: ["lakeformation:GetDataAccess"],
          resources: ["*"],
        },
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
        EVENTS_FIREHOSE_NAME: firehoses.events.name,
        INITIAL_EVENTS_FIREHOSE_NAME: firehoses.initial_events.name,
        SITES_TABLE_NAME: sitesTable.name,
      },
      permissions: [
        // Permissions for linked resources (Firehose, DynamoDB) are handled by linking
      ],
    });
    // router.route("/api/event", ingestFn.url);
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
      dataBucketName: analyticsS3TableBucket.name,
      queryResultsBucketName: athenaResultsBucket.name,
      eventsFirehoseStreamName: firehoses.events.name,
      initialEventsFirehoseStreamName: firehoses.initial_events.name,
      glueResourceLinkName: firehoseResourceLinkName,
      eventsS3TableName: s3Tables.events.name,
      initialEventsS3TableName: s3Tables.initial_events.name,
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
