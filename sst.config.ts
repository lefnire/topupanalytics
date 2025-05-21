/*
====================================================================================================
IMPORTANT PREREQUISITE FOR AWS S3 TABLES:
====================================================================================================

This stack utilizes AWS S3 Tables. Before deploying this stack (e.g., via `pulumi up` or `sst deploy`),
you MUST perform a one-time manual setup in the AWS Management Console for the specific AWS region
where this stack will be deployed.

Action Needed:
1. Navigate to the AWS Lake Formation console or the Amazon S3 console settings.
2. Look for an option related to "S3 Tables," "AWS analytics services integration," or "Application
   integration settings" (the exact phrasing may vary by region or console updates).
3. Enable this integration.

What this manual action does:
This step provisions necessary background resources required by S3 Tables, which typically include:
  - A Glue Data Catalog database named `s3tablescatalog`.
  - An IAM Role, often named `S3TablesRoleForLakeFormation` (or similar).
  - An IAM Policy, often named `S3TablesPolicyForLakeFormation` (or similar).

CRITICAL WARNING:
Failure to complete this manual setup BEFORE deploying the stack will likely result in deployment
errors. These errors may occur when Pulumi attempts to create S3 Tables resources, Glue Resource
Links to S3 Table namespaces, or related Lake Formation permissions, as the underlying
`s3tablescatalog` and associated roles will not exist.

Please ensure this prerequisite is met to avoid deployment failures.
====================================================================================================
*/
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

    if (useProdResourcesLocally && (!prodApiUrl || !prodUserPoolId || !prodClientId || !prodAppUrl)) {
      console.warn("WARN: USE_PROD_RESOURCES_LOCALLY is true, but one or more PROD_* environment variables are missing in .env. Frontend might not connect correctly.");
    }

    const useStripe = process.env.USE_STRIPE === "true";
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId;
    const region = aws.getRegionOutput({}).name;
    const partition = aws.getPartitionOutput({}).partition;
    const basename = `${$app.name}${$app.stage}`; // Used in sst.config.ts
    const s3TablesBasename = `${$app.name}-${$app.stage}`; // Used for resources adapted from sst.config.s3tables.ts to match its hyphenated style

    // === Linkable Wrappers (using global sst) ===
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: { name: stream.name, arn: stream.arn }, // Added ARN
      include: [
        sst.aws.permission({
          actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [stream.arn],
        }),
      ],
    }));
    sst.Linkable.wrap(aws.glue.CatalogDatabase, (db) => ({ // For Resource Links
      properties: { name: db.name, arn: db.arn },
      include: [
        sst.aws.permission({
          actions: ["glue:GetDatabase"],
          resources: [db.arn],
        }),
        // Permissions needed by queryFn to query tables within the linked database
        sst.aws.permission({
          actions: ["glue:GetTable", "glue:GetTables"],
          resources: [$interpolate`arn:${partition}:glue:${region}:${accountId}:table/${db.name}/*`],
        }),
      ],
    }));
    // sst.Linkable for aws.s3tables.TableBucket might be needed if functions directly interact with it.
    // For now, queryFn interacts via Lake Formation / Glue Link / Athena.
    sst.Linkable.wrap(aws.s3tables.TableBucket, (bucket) => ({
        properties: { name: bucket.name, arn: bucket.arn }, // Assuming 'name' is an output property
        include: [
            sst.aws.permission({
                actions: [
                    "s3:GetObject",
                    "s3:ListBucket",
                    // Add other S3 actions if functions directly interact with the bucket objects for S3 Tables
                ],
                resources: [bucket.arn, $interpolate`${bucket.arn}/*`],
            }),
        ],
    }));


    // === S3 Bucket for Athena Query Results ===
    const athenaResultsBucket = new sst.aws.Bucket("AthenaResults", {
      // name: `${basename}-athena-results`, // Using SST generated name for simplicity
    });
    const intelligentTieringRule: aws.types.input.s3.BucketLifecycleConfigurationV2Rule[] =
      [
        {
          id: "IntelligentTieringRule",
          status: "Enabled",
          filter: {},
          transitions: [
            {
              days: 0,
              storageClass: "INTELLIGENT_TIERING",
            },
          ],
        },
      ];
    new aws.s3.BucketLifecycleConfigurationV2(`AthenaResultsBucketLifecycle`, {
      bucket: athenaResultsBucket.name,
      rules: intelligentTieringRule,
    });

    // === S3 Tables Setup ===
    const s3TableBucketName = `${s3TablesBasename}-s3table-bucket`.toLowerCase();
    const s3TableNamespaceName = "analytics_namespace"; // Renamed for clarity
    const analyticsS3TableName = "analytics_table"; // Consolidated table name
    const firehoseBackupS3BucketName = `${s3TablesBasename}-firehose-backup`.toLowerCase();
    const firehoseStreamName = `${s3TablesBasename}-analytics-delivery-stream`; // Renamed
    const firehoseResourceLinkName = `${s3TablesBasename.replace(/-/g, "_")}_analytics_ns_link`; // Renamed

    const analyticsS3TableBucket = new aws.s3tables.TableBucket("AnalyticsS3TableBucket", {
      name: s3TableBucketName,
    });

    const analyticsS3TableNamespace = new aws.s3tables.Namespace("AnalyticsS3TableNamespace", {
      namespace: s3TableNamespaceName,
      tableBucketArn: analyticsS3TableBucket.arn,
    });

    const analyticsS3Table = new aws.s3tables.Table("AnalyticsS3Table", {
      name: analyticsS3TableName,
      namespace: analyticsS3TableNamespace.namespace,
      tableBucketArn: analyticsS3TableBucket.arn,
      format: "ICEBERG",
      // Schema (columns, types, partitioning) for this S3 Table is not defined here.
      // For Iceberg tables created/managed by Kinesis Firehose:
      // 1. Firehose typically creates or updates the schema in AWS Glue based on its
      //    configuration (e.g., source data inspection, schema inference, or a
      //    predefined schema in its processing configuration if the table doesn't exist
      //    or schema evolution is enabled).
      // 2. Alternatively, the schema can be defined or modified directly in AWS Glue
      //    (e.g., via console, SDK, or Athena DDL) after this S3 Table resource is created
      //    and before Firehose starts delivery, or if Firehose is not responsible for schema management.
    });

    const firehoseS3BackupBucket = new aws.s3.BucketV2("FirehoseS3BackupBucket", {
      bucket: firehoseBackupS3BucketName,
      forceDestroy: $app.stage !== "production",
    });
    new aws.s3.BucketPublicAccessBlock("FirehoseS3BackupBucketPab", {
        bucket: firehoseS3BackupBucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
    });

    const firehoseS3TablesRole = new aws.iam.Role("FirehoseS3TablesRole", {
      name: `${s3TablesBasename}-FirehoseS3TablesRole`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "firehose.amazonaws.com",
      }),
    });

    const firehoseS3TablesPolicyDocument = aws.iam.getPolicyDocumentOutput({
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
              firehoseS3BackupBucket.arn,
              $interpolate`${firehoseS3BackupBucket.arn}/*`,
            ],
          },
          {
            sid: "RequiredWhenDoingMetadataReadsANDDataAndMetadataWriteViaLakeformation",
            effect: "Allow",
            actions: ["lakeformation:GetDataAccess"],
            resources: ["*"],
          },
           {
             sid: "LoggingInCloudWatch",
             effect: "Allow",
             actions: ["logs:PutLogEvents"],
             resources: [$interpolate`arn:${partition}:logs:${region}:${accountId}:log-group:/aws/kinesisfirehose/${firehoseStreamName}:*`],
           },
        ],
    });

    const firehoseS3TablesPolicy = new aws.iam.Policy("FirehoseS3TablesPolicy", {
      name: `${s3TablesBasename}-FirehoseS3TablesPolicy`,
      description: "Policy for Firehose to access S3 Tables via Glue/Lake Formation and S3 for backups.",
      policy: firehoseS3TablesPolicyDocument.json,
    });

    new aws.iam.RolePolicyAttachment("FirehoseS3TablesRolePolicyAttachment", {
      role: firehoseS3TablesRole.name,
      policyArn: firehoseS3TablesPolicy.arn,
    });

    const analyticsGlueResourceLink = new aws.glue.CatalogDatabase("AnalyticsGlueResourceLink", {
      name: firehoseResourceLinkName,
      catalogId: accountId,
      targetDatabase: {
        catalogId: $interpolate`${accountId}:s3tablescatalog/${accountId}_${analyticsS3TableBucket.name}`,
        databaseName: analyticsS3TableNamespace.namespace,
      },
    }, { dependsOn: [analyticsS3TableBucket, analyticsS3TableNamespace] });

    const s3TableNamespaceLfDatabaseName = $interpolate`s3tablescatalog/${accountId}_${analyticsS3TableBucket.name}/${analyticsS3TableNamespace.namespace}`;

    new aws.lakeformation.Permissions("LfPermOnResourceLink", {
      principal: firehoseS3TablesRole.arn,
      permissions: ["DESCRIBE"],
      database: {
        catalogId: accountId,
        name: analyticsGlueResourceLink.name,
      },
    }, { dependsOn: [firehoseS3TablesRole, analyticsGlueResourceLink] });

    new aws.lakeformation.Permissions("LfPermOnTargetNamespace", {
      principal: firehoseS3TablesRole.arn,
      permissions: ["DESCRIBE", "ALTER", "CREATE_TABLE", "DROP"],
      database: {
        catalogId: accountId,
        name: s3TableNamespaceLfDatabaseName,
      },
    }, { dependsOn: [firehoseS3TablesRole, analyticsS3TableNamespace, analyticsS3TableBucket, analyticsGlueResourceLink] });

    new aws.lakeformation.Permissions("LfPermOnTargetTable", {
      principal: firehoseS3TablesRole.arn,
      permissions: ["SELECT", "INSERT", "DELETE", "DESCRIBE", "ALTER"],
      table: {
        catalogId: accountId,
        databaseName: s3TableNamespaceLfDatabaseName,
        name: analyticsS3Table.name,
      },
    }, { dependsOn: [firehoseS3TablesRole, analyticsS3Table] }); // Removed LfPermOnTargetNamespace from dependsOn as it can cause cycles if not careful, direct deps are enough.

    const analyticsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream("AnalyticsFirehoseStream", {
      name: firehoseStreamName,
      destination: "iceberg",
      icebergConfiguration: {
        roleArn: firehoseS3TablesRole.arn,
        catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
        s3Configuration: {
          roleArn: firehoseS3TablesRole.arn,
          bucketArn: firehoseS3BackupBucket.arn, // Use the dedicated backup bucket
          bufferingInterval: 300, // Default: 300s
          bufferingSize: 5, // Default: 5MB
          cloudwatchLoggingOptions: {
            enabled: true,
            logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseStreamName}-backupS3`,
            logStreamName: "S3Delivery",
          }
        },
        destinationTableConfigurations: [{
          databaseName: analyticsGlueResourceLink.name,
          tableName: analyticsS3Table.name,
        }],
      },
      // General Firehose stream logging (optional, but good practice)
      cloudwatchLoggingOptions: {
          enabled: true,
          logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseStreamName}`,
          logStreamName: "DestinationDelivery",
      },
    }, {
      dependsOn: [
        // lfPermOnResourceLink, lfPermOnTargetNamespace, lfPermOnTargetTable, // Implicitly handled by role permissions
        firehoseS3TablesRole, firehoseS3BackupBucket, analyticsGlueResourceLink, analyticsS3Table,
      ],
    });

    // === Cognito User Pool ===
    const userPool = new sst.aws.CognitoUserPool("UserPool", {
      usernames: ["email"],
      transform: {
        userPool: (args) => {
          args.name = `${basename}-user-pool`;
          args.passwordPolicy = {
            minimumLength: 7, requireLowercase: false, requireNumbers: false,
            requireSymbols: false, requireUppercase: false, temporaryPasswordValidityDays: 7,
          };
          args.accountRecoverySetting = {
            recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
          };
        },
      },
    });
    const userPoolClientSst = userPool.addClient("UserPoolClient");

    const DUMMY_STRIPE_SECRET_KEY_PLACEHOLDER = "dummy_stripe_secret_key_placeholder";
    const DUMMY_STRIPE_WEBHOOK_SECRET_PLACEHOLDER = "dummy_stripe_webhook_secret_placeholder";
    const DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER = "dummy_stripe_publishable_key_placeholder";
    const STRIPE_SECRET_KEY = useStripe ? new sst.Secret("StripeSecretKey") : undefined;
    const STRIPE_WEBHOOK_SECRET = useStripe ? new sst.Secret("StripeWebhookSecret") : undefined;
    const STRIPE_PUBLISHABLE_KEY = useStripe ? new sst.Secret("StripePublishableKey") : undefined;

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      fields: { site_id: "string", owner_sub: "string", plan: "string" },
      primaryIndex: { hashKey: "site_id" },
      globalIndexes: {
        ownerSubIndex: { hashKey: "owner_sub", projection: ["site_id"] },
        planIndex: { hashKey: "plan", projection: "all" },
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      fields: { cognito_sub: "string" },
      primaryIndex: { hashKey: "cognito_sub" },
    });

    // === Router for Public Endpoints ===
    const router = new sst.aws.Router("PublicRouter", {
      domain: isProd ? { name: domain, redirects: [`www.${domain}`] } : undefined,
    });

    // === Functions ===
    const queryFn = new sst.aws.Function("QueryFn", {
      handler: "functions/analytics/query.handler",
      timeout: "60 second", memory: "512 MB", architecture: "arm64",
      link: [
        analyticsGlueResourceLink, // Link to the Glue Resource Link for the S3 Table
        athenaResultsBucket,
        analyticsS3TableBucket, // Link to the S3 Table Bucket
        sitesTable,
        userPreferencesTable,
      ],
      environment: { USE_STRIPE: useStripe.toString() },
      permissions: [
        {
          actions: [
            "athena:StartQueryExecution", "athena:GetQueryExecution",
            "athena:GetQueryResults", "athena:StopQueryExecution",
          ],
          resources: ["*"],
        },
        {
          actions: [
            "s3:PutObject", "s3:GetObject", "s3:ListBucket",
            "s3:GetBucketLocation", "s3:DeleteObject",
          ],
          resources: [athenaResultsBucket.arn, $interpolate`${athenaResultsBucket.arn}/*`],
        },
        // Lake Formation will grant access to the S3 Table data via the queryFn's role.
        // The queryFn role needs `lakeformation:GetDataAccess` which is implicitly added by SST for linked resources if not covered by specific LF permissions.
        // Or, explicitly grant permissions on the LF side to the queryFn's IAM role.
        // For S3 Tables, also ensure the role can assume S3TablesRoleForLakeFormation if that's part of the setup.
        // The IAM policy for Firehose already includes `lakeformation:GetDataAccess`.
        // The queryFn will also need `lakeformation:GetDataAccess` if it's directly querying.
        // SST's linking mechanism for Glue/S3 resources usually handles basic Glue/S3 permissions.
        // However, for Lake Formation governed tables (which S3 Tables are), explicit LF grants might be needed
        // to the queryFn's execution role, or the queryFn's role needs to be registered as a data lake administrator/location manager.
        // For simplicity here, we rely on the user/admin setting up LF permissions for the queryFn's role if needed,
        // or the broad `lakeformation:GetDataAccess` in the Firehose role might cover some scenarios if Athena queries assume that role (unlikely).
        // A more robust solution would be to create LF permissions for the queryFn.role.
      ],
    });

    new aws.lakeformation.Permissions("LfPermQueryFnOnResourceLink", {
        principal: queryFn.role.arn,
        permissions: ["DESCRIBE"],
        database: {
            catalogId: accountId,
            name: analyticsGlueResourceLink.name,
        },
    }, { dependsOn: [queryFn, analyticsGlueResourceLink] });

    new aws.lakeformation.Permissions("LfPermQueryFnOnAnalyticsTable", {
        principal: queryFn.role.arn,
        permissions: ["SELECT", "DESCRIBE"], // Read-only for querying
        tableWithColumns: { // Grant on specific table
            catalogId: accountId,
            databaseName: s3TableNamespaceLfDatabaseName,
            name: analyticsS3Table.name,
            columnNames: ["*"], // Grant access to all columns initially
        },
        // permissionsWithGrantOption: ["SELECT"], // Optionally allow queryFn to grant access
    }, { dependsOn: [queryFn, analyticsS3Table, analyticsGlueResourceLink] });


    const sitesFn = new sst.aws.Function("SitesFn", {
      handler: "functions/api/sites.handler", timeout: "10 second", memory: "128 MB", architecture: "arm64",
      link: [sitesTable, router],
      environment: { ROUTER_URL: router.url, USE_STRIPE: useStripe.toString() },
      nodejs: { install: ["ulid"] },
    });

    const preferencesFn = new sst.aws.Function("PreferencesFn", {
      handler: "functions/api/preferences.handler", timeout: "10 second", memory: "128 MB", architecture: "arm64",
      link: [userPreferencesTable],
      environment: { USE_STRIPE: useStripe.toString() },
    });

    let stripeFn: sst.aws.Function | undefined;
    if (useStripe) {
      stripeFn = new sst.aws.Function("StripeFn", {
        handler: "functions/api/stripe.handler", timeout: "10 second", memory: "128 MB", architecture: "arm64",
        link: [STRIPE_SECRET_KEY!, STRIPE_WEBHOOK_SECRET!, userPreferencesTable, sitesTable],
        environment: { USE_STRIPE: useStripe.toString() },
        nodejs: { install: ["stripe"] },
      });
    }

    const api = new sst.aws.ApiGatewayV2("ManagementApi", {
      cors: {
        allowOrigins: isProd ? [`https://${domain}`, "http://localhost:5173", "http://127.0.0.1:5173"] : ["http://localhost:5173", "http://127.0.0.1:5173"],
        allowCredentials: true, allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"],
      },
    });
    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: { issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`, audiences: [userPoolClientSst.id] },
    });
    const commonAuth = { auth: { jwt: { authorizer: jwtAuthorizer.id } } };

    api.route("GET /api/query", queryFn.arn, commonAuth);
    api.route("POST /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("PUT /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("DELETE /api/sites/{site_id}", sitesFn.arn, commonAuth);
    api.route("GET /api/sites/{site_id}/script", sitesFn.arn, commonAuth);
    api.route("GET /api/user/preferences", preferencesFn.arn, commonAuth);
    api.route("PUT /api/user/preferences", preferencesFn.arn, commonAuth);
    if (useStripe && stripeFn) {
      api.route("POST /api/stripe/webhook", stripeFn.arn);
      api.route("POST /api/stripe/checkout", stripeFn.arn, commonAuth);
      api.route("GET /api/stripe/portal", stripeFn.arn, commonAuth);
    }
    router.route("/api/*", api.url);

    const publicIngestUrl = $interpolate`${router.url}/api/event`;
    const buildEmbedScripts = new command.local.Command("BuildEmbedScripts", {
      create: $interpolate`npx esbuild ${process.cwd()}/dashboard/embed-script/src/topup-basic.ts ${process.cwd()}/dashboard/embed-script/src/topup-enhanced.ts ${process.cwd()}/dashboard/embed-script/src/topup-full.ts --bundle --format=iife --outdir=${process.cwd()}/dashboard/public --entry-names=[name].min --define:import.meta.env.VITE_PUBLIC_INGEST_URL='"${publicIngestUrl}"'`
    });

    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      router: { instance: router, path: "/" },
      link: [api, userPool, userPoolClientSst],
      environment: {
        VITE_COGNITO_USER_POOL_ID: useProdResourcesLocally && prodUserPoolId ? prodUserPoolId : userPool.id,
        VITE_COGNITO_CLIENT_ID: useProdResourcesLocally && prodClientId ? prodClientId : userPoolClientSst.id,
        VITE_AWS_REGION: region,
        VITE_API_URL: useProdResourcesLocally && prodApiUrl ? prodApiUrl : api.url,
        VITE_APP_URL: useProdResourcesLocally && prodAppUrl ? prodAppUrl : router.url,
        VITE_STRIPE_PUBLISHABLE_KEY: useStripe ? (useProdResourcesLocally && prodStripePubKey ? prodStripePubKey : STRIPE_PUBLISHABLE_KEY!.value) : DUMMY_STRIPE_PUBLISHABLE_KEY_PLACEHOLDER,
        VITE_USE_STRIPE: useStripe.toString(),
        VITE_PUBLIC_INGEST_URL: useProdResourcesLocally && prodPublicIngestUrl ? prodPublicIngestUrl : publicIngestUrl,
      },
    }, {dependsOn: [buildEmbedScripts]});

    let chargeProcessorFn: sst.aws.Function | undefined;
    if (useStripe) {
      chargeProcessorFn = new sst.aws.Function("ChargeProcessorFn", {
        handler: "functions/billing/chargeProcessor.handler", timeout: "60 second", memory: "256 MB", architecture: "arm64",
        link: [sitesTable, userPreferencesTable, STRIPE_SECRET_KEY!],
        environment: { USE_STRIPE: useStripe.toString() },
        nodejs: { install: ["stripe", "@aws-sdk/client-dynamodb"] },
      });
      new sst.aws.Cron("ChargeCron", {
        schedule: "rate(5 minutes)",
        function: chargeProcessorFn.arn,
      });
    }

    const ingestFn = new sst.aws.Function("IngestFn", {
      handler: "functions/analytics/ingest.handler", timeout: "10 second", memory: "128 MB", architecture: "arm64",
      url: { cors: true, router: { instance: router, path: "/api/event" } },
      link: [
        analyticsFirehoseStream, // Link to the new single Firehose stream
        sitesTable,
        userPreferencesTable,
      ],
      environment: { USE_STRIPE: useStripe.toString() },
    });

    // === Outputs ===
    return {
      appName: $app.name,
      stage: $app.stage,
      accountId: accountId,
      region: region,
      dashboardUrl: router.url,
      managementApiUrl: api.url,
      publicIngestUrl: publicIngestUrl,
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      queryResultsBucketName: athenaResultsBucket.name,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClientSst.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      routerDistributionId: router.distributionID,
      chargeProcessorFunctionName: chargeProcessorFn?.name,
      stripeSecretKeyName: useStripe ? STRIPE_SECRET_KEY!.name : undefined,
      sitesFunctionName: sitesFn?.name,
      preferencesFunctionName: preferencesFn?.name,
      stripeFunctionName: stripeFn?.name,
      // New S3 Tables related outputs
      s3TableBucketArn: analyticsS3TableBucket.arn,
      s3TableBucketName: analyticsS3TableBucket.name, // Assuming 'name' is an output, else use s3TableBucketName variable
      s3TableNamespace: analyticsS3TableNamespace.namespace,
      analyticsS3TableName: analyticsS3Table.name,
      analyticsFirehoseStreamName: analyticsFirehoseStream.name,
      analyticsGlueResourceLinkName: analyticsGlueResourceLink.name,
      firehoseS3BackupBucketName: firehoseS3BackupBucket.bucket, // .bucket is the name for BucketV2

      productionEnvValues: isProd ? {
        PROD_API_URL: api.url,
        PROD_COGNITO_USER_POOL_ID: userPool.id,
        PROD_COGNITO_CLIENT_ID: userPoolClientSst.id,
        PROD_APP_URL: router.url,
        PROD_STRIPE_PUBLISHABLE_KEY: useStripe ? STRIPE_PUBLISHABLE_KEY?.value : "N/A (Stripe not enabled)",
      } : undefined,
    };
  },
});
