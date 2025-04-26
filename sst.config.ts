/// <reference path="./.sst/platform/config.d.ts" />

/*
## Data Pipeline: Cost-Optimized & Scalable Analytics

The primary goal of this data pipeline is extreme cost-effectiveness and scalability, aiming to support a high volume of events and queries affordably. The core AWS services used are Kinesis Firehose, S3, Glue, Athena, and Lambda.

#### 1. Ingest: API -> Lambda -> Firehose -> S3 (Parquet)

- **Entrypoint:** Events are sent to an API Gateway endpoint (`POST /event` via `ingestFn`). CloudFront might add geographic headers before hitting the API.
- **Processing:** The `ingestFn` Lambda receives the event payload. It distinguishes between an initial event for a session (containing full details like device, UTMs, referer) and subsequent events (minimal data: event, pathname, session_id, timestamp).
- **Delivery:** The Lambda sends the data to one of two Kinesis Firehose streams: `initial-events-stream` or `events-stream`.
- **Firehose to S3:** Firehose uses **dynamic partitioning** based on `site_id` (extracted from the payload) and `dt` (event timestamp) to write data directly into the `eventsBucket` S3 bucket. It handles JSON parsing and converts data to **Parquet** format (SNAPPY compressed) automatically, landing files under prefixes like `s3://events-bucket/initial_events/site_id=.../dt=yyyy-MM-dd/`. This avoids the need for an intermediate processing Lambda. S3 buckets utilize **Intelligent Tiering** for cost optimization.

#### 2. Storage & Catalog: S3 -> Glue (Hive + Iceberg)

- **Raw Data:** Parquet files reside in the `eventsBucket`.
- **Glue Hive Tables:** Two traditional Glue external tables (`initial_events`, `events`) are defined over the S3 paths. They use **partition projection** based on `site_id` and `dt` for efficient partition discovery by Athena without needing `MSCK REPAIR TABLE`.
- **Glue Iceberg Tables:** Upon deployment, an `IcebergInitFn` Lambda runs via `aws.lambda.Invocation`. It executes Athena `CREATE TABLE AS SELECT` (CTAS) queries to create **Apache Iceberg** tables (`initial_events_iceberg`, `events_iceberg`) based on the data in the original Hive tables. Iceberg manages its own metadata/manifest files within the `eventsBucket`, offering benefits like atomic commits, time travel, and schema evolution, and improved query performance over many small files.

#### 3. Query: API -> Lambda -> Athena (Querying Iceberg)

- **Entrypoint:** Users query data via the dashboard, hitting `GET /api/query`.
- **Execution:** The `queryFn` Lambda receives the request, constructs an Athena query, and executes it.
- **Target Tables:** Queries primarily target the **Iceberg tables** (`initial_events_iceberg`, `events_iceberg`) for better performance and data consistency. Athena queries these tables using the Glue Data Catalog.
- **Client-Side Join:** Similar to the original design, joining the `initial_events` data (session details) with the `events` data (actions within the session) is intended to happen **client-side** (using DuckDB WASM). This minimizes Athena scan costs/time, Lambda execution time/memory, and network transfer. The Lambda likely fetches raw data from both Iceberg tables for the requested `site_id` and date range.

#### 4. Maintenance: Cron -> Lambda -> Athena (Iceberg Compaction)

- **Problem:** Firehose's frequent data delivery creates many small Parquet files, which can degrade Athena query performance, even with Iceberg.
- **Solution:** A `CompactionCron` triggers the `CompactionFn` Lambda hourly.
- **Action:** This Lambda executes Athena `OPTIMIZE` commands (or potentially other maintenance operations like `VACUUM`) on the **Iceberg tables**. This process compacts small files into larger, optimally sized ones, improving subsequent query speed and efficiency. It also manages Iceberg metadata updates within Glue and S3.
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
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId
    const region = aws.getRegionOutput().name

    // === Linkable Wrappers (using global sst) ===
    // Wrap Kinesis Firehose Delivery Stream
    sst.Linkable.wrap(aws.kinesis.FirehoseDeliveryStream, (stream) => ({
      properties: { name: stream.name },
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [stream.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Database
    sst.Linkable.wrap(aws.glue.CatalogDatabase, (db) => ({
      properties: { name: db.name, arn: db.arn },
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetDatabase"],
          resources: [db.arn],
        }),
      ],
    }));

    // Wrap Glue Catalog Table
    sst.Linkable.wrap(aws.glue.CatalogTable, (table) => ({
      properties: { name: table.name, arn: table.arn, databaseName: table.databaseName },
      include: [
        sst.aws.permission({ // Use global sst.aws.permission
          actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions", "glue:GetPartition", "glue:GetPartitions"], // Read actions
          resources: [table.arn, $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, $interpolate`arn:aws:glue:${region}:${accountId}:database/${table.databaseName}`], // Include DB ARN
        }),
      ],
    }));

    // === Configuration ===
    const baseName = `${$app.name}-${$app.stage}`;

    // === S3 Buckets ===
    const eventsBucket = new sst.aws.Bucket("EventData", {});
    const queryResultsBucket = new sst.aws.Bucket("AthenaResults", {});

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
    new aws.s3.BucketLifecycleConfigurationV2(`${baseName}-event-data-lifecycle`, {
        bucket: eventsBucket.name,
        rules: intelligentTieringRule,
    });

    // Apply lifecycle rule to Athena Results Bucket
    new aws.s3.BucketLifecycleConfigurationV2(`${baseName}-athena-results-lifecycle`, {
        bucket: queryResultsBucket.name,
        rules: intelligentTieringRule,
    });

    // === Glue Data Catalog ===
    const analyticsDatabase = new aws.glue.CatalogDatabase(`${baseName}-db`, {
      name: `${baseName}_analytics_db`, // Glue names often use underscores
    });

    // Import schemas for both tables
    const { initialGlueColumns, eventsGlueColumns } = await import('./functions/analytics/schema');

    // Define partition keys once for consistency
    const commonPartitionKeys = [
      { name: "site_id", type: "string" },
      { name: "dt", type: "string" },
    ];

    // Create table for initial events (contains all session data) - Original Glue Table
    const initialEventsTable = new aws.glue.CatalogTable(`${baseName}-initial-events-table`, {
      name: `initial_events`,
      databaseName: analyticsDatabase.name,
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
        serDeInfo: { name: "parquet-serde", serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe", parameters: { "serialization.format": "1" } },
        columns: initialGlueColumns, compressed: false, storedAsSubDirectories: true,
      },
      partitionKeys: commonPartitionKeys,
    });

    // Create table for regular events (contains minimal data) - Original Glue Table
    const eventsTable = new aws.glue.CatalogTable(`${baseName}-events-table`, {
      name: `events`,
      databaseName: analyticsDatabase.name,
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
        serDeInfo: { name: "parquet-serde", serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe", parameters: { "serialization.format": "1" } },
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
      handler: "functions/infra/iceberg-init.handler", // New handler path
      timeout: "5 minutes", // Might take time
      memory: "256 MB",
      architecture: "arm64",
      link: [
        analyticsDatabase,
        initialEventsTable,
        eventsTable,
        eventsBucket,
        queryResultsBucket
      ],
      environment: { // Only pass values not available via linked resources
        INITIAL_EVENTS_ICEBERG_TABLE_NAME: "initial_events_iceberg", // String constant
        EVENTS_ICEBERG_TABLE_NAME: "events_iceberg",           // String constant
        ATHENA_WORKGROUP: "primary", // String constant
      },
      permissions: [
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"], resources: ["*"] }, // Specific Athena actions
        { actions: ["glue:CreateTable", "glue:GetTable", "glue:GetDatabase"], resources: [ // Specific Glue actions
            analyticsDatabase.arn, // Database ARN from link
            initialEventsTable.arn, // Source Table ARN from link
            eventsTable.arn,        // Source Table ARN from link
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Catalog access often needed
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${analyticsDatabase.name}/*`, // Access to tables within the DB
          ]
        },
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"], resources: [ // S3 permissions for Athena/Iceberg
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`,
            queryResultsBucket.arn, // Athena needs access to results bucket too
            $interpolate`${queryResultsBucket.arn}/*`
          ]
        },
      ],
      nodejs: {
        install: ["@aws-sdk/client-athena"],
      }
    });

    // === Invoke Iceberg Initialization Function ===
    // Only pass data not available via linked resources as input
    const icebergInitInput ={
        INITIAL_EVENTS_ICEBERG_TABLE_NAME: "initial_events_iceberg",
        EVENTS_ICEBERG_TABLE_NAME: "events_iceberg",
        ATHENA_WORKGROUP: "primary",
    };

    new aws.lambda.Invocation(`${baseName}-IcebergInitInvocation`, {
        functionName: icebergInitFn.name,
        input: $util.jsonStringify(icebergInitInput),
        triggers: {
           redeployment: Date.now().toString(),
        },
      }, { dependsOn: [icebergInitFn, initialEventsTable, eventsTable] }
    );

    // === IAM Role for Firehose ===
    const firehoseRole = new aws.iam.Role(`${baseName}-firehose-role`, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // === Firehose Processor Function (DELETED in Phase 3.1) ===
    // const firehoseProcessorFn = new sst.aws.Function("FirehoseProcessorFn", { ... });

    // Allow Firehose to write to S3 and access Glue
    new aws.iam.RolePolicy(`${baseName}-firehose-policy`, {
      role: firehoseRole.id,
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          { "Effect": "Allow", "Action": ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], "Resource": ["${eventsBucket.arn}", "${eventsBucket.arn}/*"] },
          { "Effect": "Allow", "Action": ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"], "Resource": ["${analyticsDatabase.arn}", "${eventsTable.arn}", "${initialEventsTable.arn}", "arn:aws:glue:${region}:${accountId}:catalog"] },
          { "Effect": "Allow", "Action": [ "logs:PutLogEvents" ], "Resource": "arn:aws:logs:*:*:log-group:/aws/kinesisfirehose/*:*" }
        ]
      }`,
    });

    // === Kinesis Data Firehose Delivery Streams ===
    const eventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`${baseName}-events-stream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseRole.arn, bucketArn: eventsBucket.arn,
        prefix: "events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/", // Phase 3.1: Use partitionKeyFromQuery
        errorOutputPrefix: "errors/events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/", // Phase 3.1: Use partitionKeyFromQuery
        bufferingInterval: 60, bufferingSize: 64, compressionFormat: "UNCOMPRESSED",
        dynamicPartitioningConfiguration: { enabled: true }, // Phase 3.1: Enable dynamic partitioning
        dataFormatConversionConfiguration: {
          enabled: true, inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
          schemaConfiguration: { databaseName: analyticsDatabase.name, tableName: eventsTable.name, roleArn: firehoseRole.arn },
        },
        // processingConfiguration removed in Phase 3.1
      },
    });

    const initialEventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`${baseName}-initial-events-stream`, {
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseRole.arn, bucketArn: eventsBucket.arn,
        prefix: "initial_events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/", // Phase 3.1: Use partitionKeyFromQuery
        errorOutputPrefix: "errors/initial_events/site_id=!{partitionKeyFromQuery:site_id}/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/", // Phase 3.1: Use partitionKeyFromQuery
        bufferingInterval: 60, bufferingSize: 64, compressionFormat: "UNCOMPRESSED",
        dynamicPartitioningConfiguration: { enabled: true }, // Phase 3.1: Enable dynamic partitioning
        dataFormatConversionConfiguration: {
          enabled: true, inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
          schemaConfiguration: { databaseName: analyticsDatabase.name, tableName: initialEventsTable.name, roleArn: firehoseRole.arn },
        },
        // processingConfiguration removed in Phase 3.1
      },
    });

    // === Cognito User Pool ===
    const userPool = new aws.cognito.UserPool("UserPool", {
        name: `${baseName}-user-pool`, aliasAttributes: ["email"], autoVerifiedAttributes: ["email"],
    });
    const userPoolClient = new aws.cognito.UserPoolClient("UserPoolClient", {
        name: `${baseName}-user-pool-client`, userPoolId: userPool.id, generateSecret: false,
        explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    });

    // === DynamoDB Tables ===
    const sitesTable = new sst.aws.Dynamo("SitesTable", {
      fields: { site_id: "string", owner_sub: "string", domains: "string", plan: "string" },
      primaryIndex: { hashKey: "site_id" },
      globalIndexes: {
        // GSI for querying sites by owner
        ownerSubIndex: { hashKey: "owner_sub", projection: ["site_id"] }, // Corrected: Use hashKey
      },
    });
    const userPreferencesTable = new sst.aws.Dynamo("UserPreferencesTable", {
      fields: { cognito_sub: "string", theme: "string", email_notifications: "string", plan_tier: "string" },
      primaryIndex: { hashKey: "cognito_sub" },
    });

    // === API Functions (Defined before Router) ===
    const ingestFn = new sst.aws.Function("IngestFn", {
        handler: "functions/analytics/ingest.handler",
        timeout: '10 second',
        memory: "128 MB",
        url: true,
        link: [
          eventsFirehoseStream,
          initialEventsFirehoseStream,
          sitesTable
        ],
        permissions: [
          { actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`] }
        ],
    });

    // === API Gateway ===
    const api = new sst.aws.ApiGatewayV2("MyApi", {
      domain: isProd ? {
        name: domain,
        // redirects property removed - not valid for ApiGatewayV2
      } : undefined,
      cors: { // Phase 1.3: Add CORS directly to ApiGatewayV2
        allowOrigins: isProd ? [`https://${domain}`] : ["*"],
        allowCredentials: false,
        // Assuming default allowedMethods/Headers are okay
      },
    });

    // Define JWT Authorizer (Phase 1.3 / Implicit from original config)
    const jwtAuthorizer = api.addAuthorizer({
      name: "jwtAuth",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClient.id],
      }
    });

    const queryFn = new sst.aws.Function("QueryFn", {
        handler: "functions/analytics/query.handler",
        timeout: "60 second",
        memory: "512 MB",
        link: [
           analyticsDatabase,
           queryResultsBucket,
           eventsBucket,
           sitesTable,
           userPreferencesTable
        ],
        environment: { // Only pass values not available via linked resources
            ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // String constant
            ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // String constant
        },
        permissions: [
          { actions: ["athena:*"], resources: ["*"] },
          { actions: ["s3:ListBucket"], resources: [ queryResultsBucket.arn, eventsBucket.arn ] },
          { actions: ["dynamodb:Query"], resources: [$interpolate`${sitesTable.arn}/index/ownerSubIndex`] },
        ],
    });

    // Define Query Route (Phase 1.3 / Implicit from original config)
    api.route(
      "GET /api/query",
      "functions/analytics/query.handler", // Handler as second argument
      { // Route args (including auth) as third argument
        auth: {
          jwt: {
            authorizer: jwtAuthorizer.id
          }
        }
      }
    );

    // === Dashboard (React Frontend) ===
    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      link: [api, userPool, userPoolClient, ingestFn],
      environment: {
        VITE_COGNITO_USER_POOL_ID: userPool.id,
        VITE_COGNITO_CLIENT_ID: userPoolClient.id,
        VITE_AWS_REGION: region,
      },
    });

    // === Compaction Function ===
    const compactionFn = new sst.aws.Function("CompactionFn", {
      handler: "functions/analytics/compact.handler",
      timeout: "15 minutes", memory: "512 MB", architecture: "arm64",
      link: [
        analyticsDatabase,
        eventsBucket,
        queryResultsBucket
      ],
       environment: { // Only pass values not available via linked resources
            ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // String constant
            ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // String constant
        },
      permissions: [
        { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"], resources: ["*"] }, // Specific Athena actions for OPTIMIZE/CTAS
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads", "s3:AbortMultipartUpload"], resources: [ // Broad S3 access needed for compaction/manifests
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`,
            queryResultsBucket.arn, // Access results bucket too
            $interpolate`${queryResultsBucket.arn}/*`
          ]
        },
        { actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions", "glue:UpdateTable", "glue:UpdatePartition", "glue:BatchUpdatePartition"], resources: [ // Glue Read/Update for compaction metadata
            analyticsDatabase.arn, // Database ARN from link
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, // Catalog access
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${analyticsDatabase.name}/*`, // Access to manage tables within the DB (incl. Iceberg)
            initialEventsTable.arn, // Grant access to original tables too if needed
            eventsTable.arn,
          ]
        },
      ],
    });

    // Phase 4.C: Add Cron job for compaction
    new sst.aws.Cron("CompactionCron", {
      schedule: "cron(5 * * * ? *)", // Hourly at 5 past the hour
      function: compactionFn.arn // Use the ARN of the existing compactionFn
    });

    // === Outputs ===
    return {
      appName: $app.name,
      accountId: accountId,
      compactionFunctionName: compactionFn.name,
      dashboardUrl: dashboard.url,
      apiUrl: api.url,
      ingestFunctionUrl: ingestFn.url,
      ingestFunctionName: ingestFn.name,
      queryFunctionName: queryFn.name,
      dataBucketName: eventsBucket.name,
      queryResultsBucketName: queryResultsBucket.name,
      eventsFirehoseStreamName: eventsFirehoseStream.name,
      initialEventsFirehoseStreamName: initialEventsFirehoseStream.name,
      glueDatabaseName: analyticsDatabase.name,
      eventsTableName: eventsTable.name,
      initialEventsTableName: initialEventsTable.name,
      initialEventsIcebergTableName: "initial_events_iceberg",
      eventsIcebergTableName: "events_iceberg",
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
      icebergInitFunctionName: icebergInitFn.name, // Export new function name
    }
  },
});
