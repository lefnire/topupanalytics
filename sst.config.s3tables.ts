/// <reference path="./.sst/platform/config.d.ts" />

// Prerequisite: Manually enable S3 Tables integration with AWS Analytics Services in the AWS console for the target region.
// This creates the 's3tablescatalog' in AWS Glue.

export default $config({
  app(input) {
    return {
      name: "s3tablestest",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {command: "1.0.2"},
    };
  },
  async run() {

    // ============== AWS Account and Region Information ==============
    const isProd = $app.stage === "production";
    const callerIdentity = aws.getCallerIdentityOutput({})
    const accountId = callerIdentity.accountId;
    const region = aws.getRegionOutput({}).name;
    const partition = aws.getPartitionOutput({}).partition; // Needed for ARN construction
    // Define basename early and use consistently for resource naming
    const baseName = `${$app.name}${$app.stage}`;

    const s3TableBucketName = `${baseName}-s3table-bucket`;
    const s3TableNamespaceName = "firehose_data_ns";
    const s3TableName = "streamed_events";
    const firehoseBackupBucketName = `${baseName}-firehose-backup`;
    const firehoseStreamName = `${baseName}-s3tables-delivery-stream`;
    const firehoseResourceLinkName = `${baseName}-s3table-ns-link`;

    // 1. Foundational S3 Table Resources
    const s3TableBucket = new aws.s3tables.TableBucket("s3TableBucket", {
      // The 'name' property for aws.s3tables.TableBucket is the actual bucket name.
      // Per AWS S3 Table Bucket naming rules, it must be globally unique if not scoped by account for certain APIs,
      // but for s3tables API, it's scoped. Pulumi resource name is logical.
      // Let's use the user-provided or generated name directly.
      name: s3TableBucketName,
      // Other properties like encryptionConfiguration or unreferencedFileRemoval can be added here.
    });

    const s3TableNamespace = new aws.s3tables.Namespace("s3TableNamespace", {
      namespace: s3TableNamespaceName,
      tableBucketArn: s3TableBucket.arn,
    });

    const s3Table = new aws.s3tables.Table("s3Table", {
      name: s3TableName,
      namespace: s3TableNamespace.namespace,
      tableBucketArn: s3TableBucket.arn,
      format: "ICEBERG",
      // Schema for S3 Tables (Iceberg) is managed via AWS Glue Data Catalog.
      // Firehose uses the Glue table definition (accessed via the resource link).
    });

    // 2. Standard S3 Bucket for Firehose Backups
    const backupS3Bucket = new aws.s3.BucketV2("firehoseBackupBucket", {
      bucket: firehoseBackupBucketName,
      forceDestroy: true, // For easy cleanup in dev/test; remove for production
    });

    // 3. IAM Role and Policy for Kinesis Firehose
    const firehoseRole = new aws.iam.Role("firehoseRole", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "firehose.amazonaws.com",
      }),
    });

    const firehosePolicy = new aws.iam.Policy("firehosePolicy", {
      description: "Policy for Firehose to access S3 Tables via Glue/Lake Formation and S3 for backups.",
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "GlueAccessForS3Tables",
            Effect: "Allow",
            Action: [
              "glue:GetTable",
              "glue:GetDatabase",
              "glue:UpdateTable"
            ],
            Resource: [
              // Default catalog for resource link operations
              $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:database/*`, // For the resource link itself
              // s3tablescatalog and its contents
              $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog/s3tablescatalog`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog/s3tablescatalog/*`,
              $interpolate`arn:${partition}:glue:${region}:${accountId}:database/s3tablescatalog:*`, // Covers namespaces
              $interpolate`arn:${partition}:glue:${region}:${accountId}:table/s3tablescatalog:*/*`   // Covers tables
            ],
          },
          {
            Sid: "S3DeliveryErrorBucketPermission",
            Effect: "Allow",
            Action: [
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation",
              "s3:GetObject",
              "s3:ListBucket",
              "s3:ListBucketMultipartUploads",
              "s3:PutObject"
            ],
            Resource: [
              backupS3Bucket.arn,
              $interpolate`${backupS3Bucket.arn}/*`
            ],
          },
          {
            Sid: "RequiredWhenDoingMetadataReadsANDDataAndMetadataWriteViaLakeformation",
            Effect: "Allow",
            Action: ["lakeformation:GetDataAccess"],
            Resource: "*",
          },
          // Optional: Add CloudWatch Logs permissions if logging is enabled for Firehose
          // {
          //     Sid: "LoggingInCloudWatch",
          //     Effect: "Allow",
          //     Action: ["logs:PutLogEvents"],
          //     Resource: [ $interpolate`arn:${partition.partition}:logs:${region}:${accountId}:log-group:/aws/kinesisfirehose/${firehoseStreamName}:*` ]
          // }
        ],
      }),
    });

    new aws.iam.RolePolicyAttachment("firehoseRolePolicyAttachment", {
      role: firehoseRole.name,
      policyArn: firehosePolicy.arn,
    });

    // 4. Glue Resource Link to the S3 Table Namespace
    // The resource link is created in the default catalog and points to the namespace
    // within the s3tablescatalog structure for the specific S3 Table Bucket.
    const s3TableNamespaceLink = new aws.glue.CatalogDatabase("s3TableNamespaceLink", {
      name: firehoseResourceLinkName, // This name is used as databaseName by Firehose
      catalogId: accountId, // Create the link in the default account catalog
      // For a resource link, targetDatabase specifies the target
      targetDatabase: {
        catalogId: $interpolate`${accountId}:s3tablescatalog/${s3TableBucket.name}`, // Points to the S3 Table Bucket's scope
        databaseName: s3TableNamespace.namespace, // Points to the Namespace within that bucket scope
        // region: region, // Optional if target is in a different region
      },
      // createTableDefaultPermissions is not a direct property here, managed by Lake Formation.
    });

    // 5. Lake Formation Permissions
    // Grant Firehose role DESCRIBE on the resource link
    const lfPermOnResourceLink = new aws.lakeformation.Permissions("lfPermOnResourceLink", {
      principal: firehoseRole.arn,
      permissions: ["DESCRIBE"],
      database: {
        catalogId: accountId, // Catalog where the link resides
        name: s3TableNamespaceLink.name,
      },
    });

    // Grant Firehose role permissions on the target S3 Table Namespace (database in s3tablescatalog)
    const lfPermOnS3TableNamespace = new aws.lakeformation.Permissions("lfPermOnS3TableNamespace", {
      principal: firehoseRole.arn,
      permissions: ["DESCRIBE", "ALTER", "CREATE_TABLE"], // Permissions needed for Iceberg operations
      database: {
        catalogId: $interpolate`${accountId}:s3tablescatalog/${s3TableBucket.name}`,
        name: s3TableNamespace.namespace,
      },
    }, {dependsOn: [s3TableNamespace]}); // Ensure namespace exists

    // Grant Firehose role permissions on the target S3 Table
    const lfPermOnS3Table = new aws.lakeformation.Permissions("lfPermOnS3Table", {
      principal: firehoseRole.arn,
      permissions: ["SELECT", "INSERT", "DELETE", "DESCRIBE", "ALTER"], // Comprehensive permissions for Iceberg table
      table: {
        catalogId: $interpolate`${accountId}:s3tablescatalog/${s3TableBucket.name}`,
        databaseName: s3TableNamespace.namespace,
        name: s3Table.name,
      },
    }, {dependsOn: [s3Table]}); // Ensure table exists

    // 6. Kinesis Firehose Delivery Stream
    const firehoseDeliveryStream = new aws.kinesis.FirehoseDeliveryStream("firehoseDeliveryStream", {
      name: firehoseStreamName,
      destination: "iceberg",
      icebergConfiguration: {
        roleArn: firehoseRole.arn,
        catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`, // Default Glue catalog
        s3Configuration: {
          roleArn: firehoseRole.arn,
          bucketArn: backupS3Bucket.arn,
          bufferingInterval: 300, // Default 300s
          bufferingSize: 5,       // Default 5MB
          // compressionFormat: "GZIP", // Optional
        },
        destinationTableConfigurations: [{
          databaseName: s3TableNamespaceLink.name,
          tableName: s3Table.name,
        }],
        // Optional: processingConfiguration for Lambda transformations or JQ parsing
        // processingConfiguration: {
        //     enabled: true,
        //     processors:
        //     }]
        // }
      },
      // Optional: Enable CloudWatch logging
      // cloudwatchLoggingOptions: {
      //     enabled: true,
      //     logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseStreamName}`,
      //     logStreamName: "DestinationDelivery"
      // },
    }, {
      dependsOn: [
        lfPermOnResourceLink,
        lfPermOnS3TableNamespace,
        lfPermOnS3Table,
        firehoseRole, // Relies on role and policy attachment (implicitly via firehoseRole.arn usage)
        backupS3Bucket,
        s3TableNamespaceLink,
      ]
    });

    return {
      s3TableBucketArn: s3TableBucket.arn,
      s3TableBucketName: s3TableBucket.name,
      s3TableNamespaceName: s3TableNamespace.namespace,
      s3TableName: s3Table.name,
      firehoseRoleArn: firehoseRole.arn,
      glueResourceLinkName: s3TableNamespaceLink.name,
      firehoseBackupS3BucketName: backupS3Bucket.bucket,
      firehoseDeliveryStreamName: firehoseDeliveryStream.name,
      firehoseDeliveryStreamArn: firehoseDeliveryStream.arn,
    };
  }
});