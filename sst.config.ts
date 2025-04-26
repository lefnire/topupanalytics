/// <reference path="./.sst/platform/config.d.ts" />

/*
## Data Pipeline

The data storage & retrieval is meant to be the cheapest, most scalable solution possible. The goal is to offer this tool to the whole internet for free (or at least extremely cheap, like $5 per million queries) so cost & scalability vastly outweigh simplicity or elegance. To wit, the current implemntation is: Kinesis Firehose, S3, Glue, and Athena - found in /sst.config.ts. If you, agent, ever see room for high-level cost/scale architectural improvement or overhauls, please (a) make the improvements if it's low-hanging fruit; or (b) tell me what needs doing, if it's a larger overhaul project. Even so far as a total system redesign, starting from scratch, - it's that important to get cost/scale down.

#### 1. Ingest: Lambda -> Firehose -> S3 + Glue

Customers submit events to `POST /event` - file /functions/analytics/ingest.ts - a Lambda behind APIG (plus CloudFront to add extra headers like country, region, etc). This submits events to Kinesis Firehose, which stores data as .parquet files in S3, in two Glue tables. `initial_events` and `events`. When the user first lands on a site (initiating a session), a single page_view is sent to `POST /event` with as much info as possible:
```
event, pathname, session_id, timestamp, properties, distinct_id, city, region, country, timezone, device, browser, browser_version, os, os_version, model, manufacturer, referer, referer_domain, screen_height, screen_width, utm_source, utm_campaign, utm_medium, utm_content, utm_term
```
This is saved to `s3://events-bucket/initial_events`. Then all subsequent events within the browsing session send the bare necessities:
```
event, pathname, session_id, timestamp, properties
```
These are saved to `s3://events-bucket/events`. Later when sessions are sliced and diced via the analytics tool, `events` are "hydrated" with all the properties of the `initial_event` associated by session_id.

**Partitioning**: Events are partitioned by `dt=yyyy-MM-dd`. I was told this makes for faster lookup via Athena than `year=yyyy/month=MM/day=dd` due to reduced scans, and the fact Athena can prune partitions early using date SQL.

#### 2. Query: Lambda -> Athena

When customers view their analytics dashboard `GET /query` - file /functions/analytics/query.ts - Athena queries the two tables based on the date range requested. Joining `initial_events` and `events` by session_id will happen client-side, to save on Athena query time (crucial), Lambda RAM requirements, and network latency. The client uses DuckDB WASM SQL, so it's fully capable of slicing and dicing.

#### 3. Compression Cron

The .parquet files in S3 are flushed from Firehose frequently, so that users can see today's data in as close to real time as possible. The result is many tiny .parquet files, which hurts Athena query performance. So a cron job compacts those little parquet files in to larger chunks.
 */

import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena"; // SDK for dynamic resource

// Removed incorrect imports for aws, sst, cr, iam as they are globals or incorrect
// Removed incorrect import for pulumi

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


    // === Configuration ===
    const baseName = `${$app.name}-${$app.stage}`;

    // === S3 Buckets ===
    const eventsBucket = new sst.aws.Bucket("EventData", {
      transform: {
        bucket: (args) => {
          args.lifecycleRules = [
            {
              id: "IntelligentTieringRule",
              enabled: true, // Use 'enabled' instead of 'status' for BucketV2
              transitions: [
                {
                  days: 0,
                  storageClass: "INTELLIGENT_TIERING",
                },
              ],
              // No filter needed, applies to the whole bucket
            },
          ];
        },
      }
    })
    const queryResultsBucket = new sst.aws.Bucket("AthenaResults", {})

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

    // === Iceberg Tables (Created via Custom Resource below) ===
    // Placeholder Glue tables removed in Phase 4.A

    // === Custom Resource for Iceberg Table Creation (Phase 4.A) ===
    class AthenaQueryExecutorProvider implements pulumi.dynamic.ResourceProvider { // Revert to pulumi.dynamic
      async create(inputs: any): Promise<pulumi.dynamic.CreateResult> { // Revert to pulumi.dynamic
        const athena = new AthenaClient({});
        try {
          const command = new StartQueryExecutionCommand({
            QueryString: inputs.queryString,
            WorkGroup: inputs.workgroup, // Use default workgroup or specify one
            ResultConfiguration: {
              OutputLocation: inputs.outputLocation,
            },
            QueryExecutionContext: {
              Database: inputs.databaseName,
            },
          });
          await athena.send(command);
          // We don't wait for completion, just trigger it.
          // Use a fixed ID to ensure it runs only once per stack create/update.
          return { id: inputs.physicalId, outs: {} };
        } catch (error) {
          console.error("Athena query execution failed:", error);
          throw error;
        }
      }
      // Define update and delete if needed, otherwise they default to no-op
      // async update(id: string, olds: any, news: any): Promise<pulumi.dynamic.UpdateResult> { ... }
      // async delete(id: string, props: any): Promise<void> { ... }
    }

    // Assuming default workgroup 'primary' is sufficient
    // const athenaWorkgroup = aws.athena.getWorkgroupOutput({ name: "primary" }); // Incorrect function

    // Custom Resource Instance for initial_events_iceberg
    new pulumi.dynamic.Resource(`${baseName}-InitialEventsIcebergInit`, { // Revert to pulumi.dynamic
        physicalId: `${baseName}-initial_events_iceberg_init`, // Fixed ID
        queryString: $interpolate`
          CREATE TABLE IF NOT EXISTS "${analyticsDatabase.name}"."initial_events_iceberg"
          WITH (
            table_type='ICEBERG',
            format='PARQUET',
            external_location='s3://${eventsBucket.name}/initial_events/',
            partitioning=ARRAY['site_id','dt']
          ) AS
          SELECT * FROM "${analyticsDatabase.name}"."initial_events"
        `,
        databaseName: analyticsDatabase.name,
        workgroup: "primary", // Use default workgroup name directly
        outputLocation: $interpolate`s3://${queryResultsBucket.name}/iceberg-init-ddl/`,
      }, { provider: new AthenaQueryExecutorProvider(), dependsOn: [initialEventsTable] } // Depends on the source Glue table
    );

    // Custom Resource Instance for events_iceberg
    new pulumi.dynamic.Resource(`${baseName}-EventsIcebergInit`, { // Revert to pulumi.dynamic
        physicalId: `${baseName}-events_iceberg_init`, // Fixed ID
        queryString: $interpolate`
          CREATE TABLE IF NOT EXISTS "${analyticsDatabase.name}"."events_iceberg"
          WITH (
            table_type='ICEBERG',
            format='PARQUET',
            external_location='s3://${eventsBucket.name}/events/',
            partitioning=ARRAY['site_id','dt']
          ) AS
          SELECT * FROM "${analyticsDatabase.name}"."events"
        `,
        databaseName: analyticsDatabase.name,
        workgroup: "primary", // Use default workgroup name directly
        outputLocation: $interpolate`s3://${queryResultsBucket.name}/iceberg-init-ddl/`,
      }, { provider: new AthenaQueryExecutorProvider(), dependsOn: [eventsTable] } // Depends on the source Glue table
    );


    // === IAM Role for Firehose ===
    const firehoseRole = new aws.iam.Role(`${baseName}-firehose-role`, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // === Firehose Processor Function (DELETED in Phase 3.1) ===
    // const firehoseProcessorFn = new sst.aws.Function("FirehoseProcessorFn", { ... });

    // Allow Firehose to write to S3 and access Glue (Processor policy DELETED in Phase 3.1)
    new aws.iam.RolePolicy(`${baseName}-firehose-policy`, {
      role: firehoseRole.id,
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          { "Effect": "Allow", "Action": ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], "Resource": ["${eventsBucket.arn}", "${eventsBucket.arn}/*"] },
          { "Effect": "Allow", "Action": ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"], "Resource": ["${analyticsDatabase.arn}", "${eventsTable.arn}", "${initialEventsTable.arn}", "arn:aws:glue:${region}:${accountId}:catalog"] },
          { "Effect": "Allow", "Action": [ "logs:PutLogEvents" ], "Resource": "arn:aws:logs:*:*:log-group:/aws/kinesisfirehose/*:*" }
          // { "Effect": "Allow", "Action": [ "lambda:InvokeFunction" ], "Resource": "..." } // Removed processor permission (and reference)
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
        url: true, // Phase 2.1: Enable Function URL (Try simple boolean first)
        // TODO: Revisit URL config (authType, cors) if needed after type errors resolved
        environment: {
          EVENTS_FIREHOSE_STREAM_NAME: eventsFirehoseStream.name,
          INITIAL_EVENTS_FIREHOSE_STREAM_NAME: initialEventsFirehoseStream.name,
          SITES_TABLE_NAME: sitesTable.name,
        },
        permissions: [
          { actions: ["firehose:PutRecord", "firehose:PutRecordBatch"], resources: [eventsFirehoseStream.arn, initialEventsFirehoseStream.arn] },
          { actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"], resources: [sitesTable.arn] }
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
        // url property removed - will be configured via api.route()
        environment: {
          ATHENA_DATABASE: analyticsDatabase.name,
          ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // Phase 4.B: Use Iceberg table name string
          ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // Phase 4.B: Use Iceberg table name string
          ATHENA_OUTPUT_LOCATION: $interpolate`s3://${queryResultsBucket.name}/`,
          SITES_TABLE_NAME: sitesTable.name,
          USER_PREFERENCES_TABLE_NAME: userPreferencesTable.name,
        },
        permissions: [
          // { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"], resources: ["*"] }, // Replaced by broader permission below
          { actions: ["athena:*"], resources: ["*"] }, // Phase 4.B: Add Athena permissions
          { actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions", "glue:GetPartition"],
            resources: [ analyticsDatabase.arn, initialEventsTable.arn, eventsTable.arn, /* initialEventsIcebergTable.arn, eventsIcebergTable.arn, */ $interpolate`arn:aws:glue:${region}:${accountId}:catalog` ] }, // Removed Iceberg table ARNs as they are created dynamically
          { actions: ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:AbortMultipartUpload", "s3:GetBucketLocation"],
            resources: [ queryResultsBucket.arn, $interpolate`${queryResultsBucket.arn}/*`, eventsBucket.arn, $interpolate`${eventsBucket.arn}/*` ] },
          { actions: ["dynamodb:Query"], resources: [sitesTable.arn, $interpolate`${sitesTable.arn}/index/ownerSubIndex`] },
          { actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"], resources: [userPreferencesTable.arn] }
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
      // router property removed - React component doesn't link directly to ApiGatewayV2
      environment: {
        VITE_APP_URL: api.url, // Use ApiGatewayV2 URL
        VITE_API_PATH: "", // API path is now part of the full URL, not separate
        VITE_COGNITO_USER_POOL_ID: userPool.id,
        VITE_COGNITO_CLIENT_ID: userPoolClient.id,
        VITE_AWS_REGION: region, // Phase 0 & 1.2: Add region
        VITE_INGEST_URL: ingestFn.url, // Phase 2.3 (Infrastructure side): Expose ingest function URL
      },
    });

    // === Compaction Function ===
    const compactionFn = new sst.aws.Function("CompactionFn", {
      handler: "functions/analytics/compact.handler",
      timeout: "15 minutes", memory: "512 MB", architecture: "arm64",
      environment: { // Phase 4.B: Update env vars
        ATHENA_DATABASE: analyticsDatabase.name,
        ATHENA_INITIAL_EVENTS_ICEBERG_TABLE: "initial_events_iceberg", // Use table name string
        ATHENA_EVENTS_ICEBERG_TABLE: "events_iceberg",           // Use table name string
        EVENTS_BUCKET_NAME: eventsBucket.name,
        ATHENA_OUTPUT_LOCATION: $interpolate`s3://${queryResultsBucket.name}/athena_compaction_results/`,
      },
      permissions: [ // Phase 4.B: Update permissions
        // { actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"], resources: ["*"] }, // Replaced by broader permission below
        { actions: ["athena:*"], resources: ["*"] }, // Add Athena permissions
        { actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions", "glue:CreatePartition", "glue:UpdatePartition", "glue:CreateTable", "glue:DeleteTable", "glue:GetPartition"],
          resources: [ analyticsDatabase.arn, initialEventsTable.arn, eventsTable.arn, /* initialEventsIcebergTable.arn, eventsIcebergTable.arn, */ $interpolate`arn:aws:glue:${region}:${accountId}:catalog`, $interpolate`arn:aws:glue:${region}:${accountId}:table/${analyticsDatabase.name}/*` ] }, // Removed Iceberg table ARNs
        { actions: ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:GetBucketLocation"],
          resources: [ queryResultsBucket.arn, $interpolate`${queryResultsBucket.arn}/*`, eventsBucket.arn, $interpolate`${eventsBucket.arn}/*` ] }
      ],
    });

    // === Outputs ===
    return {
      appName: $app.name,
      accountId: accountId,
      compactionFn: $interpolate`AWS_PROFILE=diyadmin AWS_REGION=us-east-1 aws lambda invoke --function-name ${compactionFn.name} --cli-binary-format raw-in-base64-out /dev/stdout`,
      dashboardUrl: dashboard.url,
      apiUrl: api.url, // Export the ApiGatewayV2 URL
      ingestFunctionUrl: ingestFn.url, // Export the direct ingest Function URL
      ingestFunctionName: ingestFn.name, // Export function name
      queryFunctionName: queryFn.name,   // Export function name
      dataBucketName: eventsBucket.name,
      queryResultsBucketName: queryResultsBucket.name,
      eventsFirehoseStreamName: eventsFirehoseStream.name,
      initialEventsFirehoseStreamName: initialEventsFirehoseStream.name,
      glueDatabaseName: analyticsDatabase.name,
      eventsTableName: eventsTable.name,
      initialEventsTableName: initialEventsTable.name,
      initialEventsIcebergTableName: "initial_events_iceberg", // Output table name string
      eventsIcebergTableName: "events_iceberg",           // Output table name string
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
      sitesTableName: sitesTable.name,
      userPreferencesTableName: userPreferencesTable.name,
      isProd,
    }
  },
});
