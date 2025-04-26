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
    // Bucket for raw event data delivered by Firehose
    const eventsBucket = new sst.aws.Bucket("EventData", {})
    const queryResultsBucket = new sst.aws.Bucket("AthenaResults", {})

    // === Glue Data Catalog ===
    const analyticsDatabase = new aws.glue.CatalogDatabase(`${baseName}-db`, {
      name: `${baseName}_analytics_db`, // Glue names often use underscores
    });

    // Import schemas for both tables
    const {initialGlueColumns, eventsGlueColumns} = await import('./functions/analytics/schema');

    // Create table for initial events (contains all session data)
    const initialEventsTable = new aws.glue.CatalogTable(`${baseName}-initial-events-table`, {
      name: `initial_events`,
      databaseName: analyticsDatabase.name,
      tableType: "EXTERNAL_TABLE", // Because data is in S3
      parameters: {
        "external": "TRUE",
        "parquet.compression": "SNAPPY", // Matches Firehose output setting
        "classification": "parquet",

        // partition projection settings
        "projection.enabled": "true",
        "projection.dt.type": "date",
        "projection.dt.format": "yyyy-MM-dd",
        "projection.dt.range": "2020-01-01,NOW", // Adjust range as needed
        "storage.location.template": $interpolate`s3://${eventsBucket.name}/initial_events/dt=\${dt}/`,
      },
      storageDescriptor: {
        location: $interpolate`s3://${eventsBucket.name}/initial_events/`, // Point to the initial_events prefix
        inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
        serDeInfo: {
          name: "parquet-serde",
          serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
          parameters: {
            "serialization.format": "1",
          },
        },
        // Define columns for initial events (all fields)
        columns: initialGlueColumns,
        compressed: false, // Data is compressed within Parquet files, not the descriptor itself
        storedAsSubDirectories: true, // Important for partitioning
      },
      // IMPORTANT: Define partition keys matching the S3 prefix structure Firehose creates
      partitionKeys: [
        {name: "dt", type: "string"}, // Single date partition key
      ],
    });

    // Create table for regular events (contains minimal data)
    const eventsTable = new aws.glue.CatalogTable(`${baseName}-events-table`, {
      name: `events`,
      databaseName: analyticsDatabase.name,
      tableType: "EXTERNAL_TABLE", // Because data is in S3
      parameters: {
        "external": "TRUE",
        "parquet.compression": "SNAPPY", // Matches Firehose output setting
        "classification": "parquet",

        // partition projection settings
        "projection.enabled": "true",
        "projection.dt.type": "date",
        "projection.dt.format": "yyyy-MM-dd",
        "projection.dt.range": "2020-01-01,NOW", // Adjust range as needed
        "storage.location.template": $interpolate`s3://${eventsBucket.name}/events/dt=\${dt}/`,
      },
      storageDescriptor: {
        location: $interpolate`s3://${eventsBucket.name}/events/`, // Point to the events prefix
        inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
        serDeInfo: {
          name: "parquet-serde",
          serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
          parameters: {
            "serialization.format": "1",
          },
        },
        // Define columns for regular events (minimal fields)
        columns: eventsGlueColumns,
        compressed: false, // Data is compressed within Parquet files, not the descriptor itself
        storedAsSubDirectories: true, // Important for partitioning
      },
      // IMPORTANT: Define partition keys matching the S3 prefix structure Firehose creates
      partitionKeys: [
        {name: "dt", type: "string"}, // Single date partition key
      ],
    });


    // === IAM Role for Firehose ===
    const firehoseRole = new aws.iam.Role(`${baseName}-firehose-role`, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({Service: "firehose.amazonaws.com"}),
    });

    // Allow Firehose to write to the S3 data bucket
    new aws.iam.RolePolicy(`${baseName}-firehose-s3-policy`, {
      role: firehoseRole.id,
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
              "s3:PutObject"
            ],
            "Resource": [
              "${eventsBucket.arn}",
              "${eventsBucket.arn}/*"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [
              "glue:GetTable",
              "glue:GetTableVersion",
              "glue:GetTableVersions"
             ],
            "Resource": [
              "${analyticsDatabase.arn}",
              "${eventsTable.arn}",
              "${initialEventsTable.arn}",
              "arn:aws:glue:${region}:${accountId}:catalog"
            ]
          },
          {
            "Effect": "Allow",
            "Action": [ "logs:PutLogEvents" ],
            "Resource": "arn:aws:logs:*:*:log-group:/aws/kinesisfirehose/*:*"
          }
        ]
      }`,
    });

    // === Kinesis Data Firehose Delivery Streams ===
    // Stream for regular events (minimal data)
    const eventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`${baseName}-events-stream`, {
      destination: "extended_s3", // Use extended_s3 for partitioning and format conversion
      extendedS3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: eventsBucket.arn,
        // IMPORTANT: Partitioning based on arrival time.
        // Format: dt=YYYY-MM-DD based on UTC arrival time.
        prefix: "events/dt=!{timestamp:yyyy-MM-dd}/",
        errorOutputPrefix: "errors/events/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/",
        bufferingInterval: 60, // Buffer for 60 seconds (adjust as needed)
        bufferingSize: 64, // Buffer up to 64 MB (adjust as needed)
        compressionFormat: "UNCOMPRESSED", // Data Format Conversion handles compression
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: {
            deserializer: {
              openXJsonSerDe: {}, // Assumes input is JSON
            },
          },
          outputFormatConfiguration: {
            serializer: {
              parquetSerDe: { // Convert to Parquet
                compression: "SNAPPY", // Or GZIP, etc.
              },
            },
          },
          // IMPORTANT: Schema must match the target Glue table (excluding partition keys)
          schemaConfiguration: {
            databaseName: analyticsDatabase.name,
            tableName: eventsTable.name,
            roleArn: firehoseRole.arn, // Role needs glue:GetTable permissions
          },
        },
      },
    });

    // Stream for initial events (complete session data)
    const initialEventsFirehoseStream = new aws.kinesis.FirehoseDeliveryStream(`${baseName}-initial-events-stream`, {
      destination: "extended_s3", // Use extended_s3 for partitioning and format conversion
      extendedS3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: eventsBucket.arn,
        // IMPORTANT: Partitioning based on arrival time.
        // Format: dt=YYYY-MM-DD based on UTC arrival time.
        prefix: "initial_events/dt=!{timestamp:yyyy-MM-dd}/",
        errorOutputPrefix: "errors/initial_events/dt=!{timestamp:yyyy-MM-dd}/!{firehose:error-output-type}/",
        bufferingInterval: 60, // Buffer for 60 seconds (adjust as needed)
        bufferingSize: 64, // Buffer up to 64 MB (adjust as needed)
        compressionFormat: "UNCOMPRESSED", // Data Format Conversion handles compression
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: {
            deserializer: {
              openXJsonSerDe: {}, // Assumes input is JSON
            },
          },
          outputFormatConfiguration: {
            serializer: {
              parquetSerDe: { // Convert to Parquet
                compression: "SNAPPY", // Or GZIP, etc.
              },
            },
          },
          // IMPORTANT: Schema must match the target Glue table (excluding partition keys)
          schemaConfiguration: {
            databaseName: analyticsDatabase.name,
            tableName: initialEventsTable.name,
            roleArn: firehoseRole.arn, // Role needs glue:GetTable permissions
          },
        },
      },
    });

    const router = new sst.aws.Router("MyRouter", {
      // Domain configuration depends on whether it's production
      // domain: undefined,
      domain: isProd ? {
        name: domain,
        redirects: [`www.${domain}`],
        // Add DNS config if needed: dns: sst.aws.dns({ zone: "YOUR_ZONE_ID" })
      } : undefined,
      // Routes will be defined within the function/site components below
    });

    // === Ingest Function (with Function URL & Router integration) ===
    const ingestFn = new sst.aws.Function("IngestFn", {
        handler: "functions/analytics/ingest.handler",
        url: {
          cors: true, // Keep direct Function URL enabled with CORS if needed
          router: {    // Integrate with the router
            instance: router,
            path: "/api/events" // Expose this function at /api/events via the router
          }
        },
        timeout: '10 second',
        memory: "128 MB",
        environment: {
          EVENTS_FIREHOSE_STREAM_NAME: eventsFirehoseStream.name,
          INITIAL_EVENTS_FIREHOSE_STREAM_NAME: initialEventsFirehoseStream.name,
        },
        permissions: [
            {
              actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
              resources: [eventsFirehoseStream.arn, initialEventsFirehoseStream.arn]
            }
        ],
    });

    // === Query Function (with Function URL & Router integration) ===
    const queryFn = new sst.aws.Function("QueryFn", {
        handler: "functions/analytics/query.handler",
        url: {
          cors: true, // Keep direct Function URL enabled with CORS if needed
          router: {    // Integrate with the router
            instance: router,
            path: "/api/query" // Expose this function at /api/query via the router
          }
        },
        timeout: "60 second", // Athena queries can take longer
        memory: "512 MB",
        environment: {
          ATHENA_DATABASE: analyticsDatabase.name,
          ATHENA_INITIAL_EVENTS_TABLE: initialEventsTable.name,
          ATHENA_EVENTS_TABLE: eventsTable.name,
          ATHENA_OUTPUT_LOCATION: $interpolate`s3://${queryResultsBucket.name}/`,
        },
        permissions: [
          {
            actions: [
              "athena:StartQueryExecution",
              "athena:GetQueryExecution",
              "athena:GetQueryResults",
              "athena:StopQueryExecution"
            ],
            resources: ["*"] // FIXME!
          },
          {
            actions: [
              "glue:GetDatabase",
              "glue:GetTable",
              "glue:GetPartitions",
              "glue:GetPartition"
            ],
            resources: [
              analyticsDatabase.arn,
              initialEventsTable.arn,
              eventsTable.arn,
              $interpolate`arn:aws:glue:${region}:${accountId}:catalog`
            ]
          },
          {
            actions: [
              "s3:GetObject",
              "s3:ListBucket",
              "s3:PutObject",
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation"
            ],
            resources: [
              queryResultsBucket.arn,
              $interpolate`${queryResultsBucket.arn}/*`,
              $interpolate`${eventsBucket.arn}`,
              $interpolate`${eventsBucket.arn}/*`
            ]
          }
        ],
    });

    const dashboard = new sst.aws.React("Dashboard", {
      path: "dashboard/",
      // Domain handled by Router
      router: { // Integrate with the router
        instance: router
        // path: "/" // Default path is "/", so this is optional
      },
      // Pass Router URL and API path to the React app
      environment: {
        VITE_APP_URL: router.url, // Base URL served by the router
        VITE_API_PATH: "/api",    // Path prefix for API calls
      },
    });

    // === Router for CloudFront Functionality and Domain ===
    // Routes are now configured within the respective Function/React components above.

    // // === Athena Compaction Cron Job ===
    // const compactionCron = new sst.aws.Cron("AthenaCompactionCron", {
    //     schedule: "cron(5 1 * * ? *)", // Daily at 1:05 AM UTC
    //     // Use 'function' instead of 'job'
    //     function: {
    const compactionFn = new sst.aws.Function("CompactionFn", {
      handler: "functions/analytics/compact.handler",
      timeout: "15 minutes",
      memory: "512 MB",
      architecture: "arm64",
      environment: {
        ATHENA_DATABASE: analyticsDatabase.name,
        ATHENA_INITIAL_EVENTS_TABLE: initialEventsTable.name,
        ATHENA_EVENTS_TABLE: eventsTable.name,
        EVENTS_BUCKET_NAME: eventsBucket.name,
        ATHENA_OUTPUT_LOCATION: $interpolate`s3://${queryResultsBucket.name}/athena_compaction_results/`,
      },
      // Define permissions inline using FunctionArgs 'permissions'
      permissions: [
        // Athena
        {
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution"
          ],
          resources: ["*"], // TODO: Scope down if possible
        },
        // Glue
        {
          actions: [
            "glue:GetDatabase",
            "glue:GetTable",
            "glue:GetPartitions",
            "glue:CreatePartition",
            "glue:UpdatePartition",
            "glue:CreateTable",
            "glue:DeleteTable",
            "glue:GetPartition"
          ],
          resources: [
            analyticsDatabase.arn,
            initialEventsTable.arn,
            eventsTable.arn,
            $interpolate`arn:aws:glue:${region}:${accountId}:catalog`,
            $interpolate`arn:aws:glue:${region}:${accountId}:table/${analyticsDatabase.name}/*_compact_*`
          ]
        },
        // S3
        {
          actions: [
            "s3:GetObject",
            "s3:ListBucket",
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:AbortMultipartUpload",
            "s3:GetBucketLocation"
          ],
          resources: [
            queryResultsBucket.arn,
            $interpolate`${queryResultsBucket.arn}/*`,
            eventsBucket.arn,
            $interpolate`${eventsBucket.arn}/*`
          ]
        }
      ],
    });

    return {
      appName: $app.name,
      accountId: accountId,
      // use $interpolate to show how to call this arn in CLI. Something about base64 thingy is required 
      compactionFn: $interpolate`AWS_PROFILE=diyadmin AWS_REGION=us-east-1 aws lambda invoke --function-name ${compactionFn.name} --cli-binary-format raw-in-base64-out /dev/stdout`,
      dashboardUrl: dashboard.url,
      routerUrl: router.url,      // Export the main router URL
      ingestUrl: ingestFn.url,     // Export direct ingest URL
      queryUrl: queryFn.url,       // Export direct query URL
      dataBucketName: eventsBucket.name,
      queryResultsBucketName: queryResultsBucket.name,
      eventsFirehoseStreamName: eventsFirehoseStream.name,
      initialEventsFirehoseStreamName: initialEventsFirehoseStream.name,
      glueDatabaseName: analyticsDatabase.name,
      eventsTableName: eventsTable.name,
      initialEventsTableName: initialEventsTable.name,
      isProd,
    }
  },
});
