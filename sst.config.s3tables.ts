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
/// <reference path="./.sst/platform/config.d.ts" />


export default $config({
  app(input) {
    return {
      name: "s3tablestest",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage ?? ''),
      home: "aws",
      providers: { aws: true, command: "1.0.2" }, // Assuming SST handles provider configuration
    };
  },
  async run() {
    const callerIdentity = await aws.getCallerIdentity({});
    const accountId = callerIdentity.accountId;
    const region = await aws.getRegion({});
    const partition = await aws.getPartition({});

    const baseName = `${$app.name}-${$app.stage}`; // SST uses '-' as default stage separator

    const s3TableBucketName = `${baseName}-s3table-bucket`.toLowerCase(); // Bucket names are lowercase
    const s3TableNamespaceName = "firehose_data_ns"; // Keep underscores, good for Glue
    const s3TableName = "streamed_events"; // Keep underscores
    const firehoseBackupBucketName = `${baseName}-firehose-backup`.toLowerCase();
    const firehoseStreamName = `${baseName}-s3tables-delivery-stream`;

    // Resource link names for Firehose can only contain letters, numbers, and underscores.
    const firehoseResourceLinkName = `${baseName.replace(/-/g, "_")}_s3table_ns_link`;

    // 1. Foundational S3 Table Resources
    const s3TableBucket = new aws.s3tables.TableBucket("s3TableBucket", {
      name: s3TableBucketName,
      // Ensure this name is unique if not automatically scoped by AWS for s3tables API.
      // Pulumi will make it unique in terms of logical resource name.
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
      // Schema (columns, types, partitioning) for this S3 Table is not defined here.
      // For Iceberg tables created/managed by Kinesis Firehose:
      // 1. Firehose typically creates or updates the schema in AWS Glue based on its
      //    configuration (e.g., source data inspection, schema inference, or a
      //    predefined schema in its processing configuration if the table doesn't exist
      //    or schema evolution is enabled).
      // 2. Alternatively, the schema can be defined or modified directly in AWS Glue
      //    (e.g., via console, SDK, or Athena DDL) after this S3 Table resource is created
      //    and before Firehose starts delivery, or if Firehose is not responsible for schema management.
      //
      // Note on multiple schemas/tables:
      // The original sst.config.ts managed two tables ('events', 'initial_events') with potentially
      // different schemas. If that setup is still required, this 's3Table' resource would need to be
      // duplicated and customized for each distinct table (e.g., different names). Associated
      // resources like Kinesis Firehose (if separate streams are needed for different schemas),
      // Glue Resource Links, and Lake Formation permissions would also need to be adjusted or duplicated.
    });

    // 2. Standard S3 Bucket for Firehose Backups
    const backupS3Bucket = new aws.s3.BucketV2("firehoseBackupBucket", {
      bucket: firehoseBackupBucketName,
      forceDestroy: $app.stage !== "production",
    });
    new aws.s3.BucketPublicAccessBlock("firehoseBackupBucketPab", {
        bucket: backupS3Bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
    });


    // 3. IAM Role and Policy for Kinesis Firehose
    const firehoseRole = new aws.iam.Role("firehoseRole", {
      name: `${baseName}-FirehoseS3TablesRole`,
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
              "glue:GetTable",
              "glue:GetTables",
              "glue:GetDatabase",
              "glue:GetDatabases",
              "glue:CreateTable",
              "glue:UpdateTable",
              // Potentially "glue:DeleteTable" if Firehose needs to manage table lifecycle
            ],
            resources: [
              // Default catalog (for the resource link and general Glue access)
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:catalog`,
              // Resource Link (database in the default catalog) - Firehose targets this
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:database/${firehoseResourceLinkName}`,
              // Tables under the Resource Link - Firehose targets this
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:table/${firehoseResourceLinkName}/*`,
              // s3tablescatalog (for S3 Tables service, via Lake Formation)
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:catalog/s3tablescatalog`,
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:catalog/s3tablescatalog/*`,
              // Broader permissions as per AWS S3 Tables documentation for Firehose
              // These also cover the resource link and s3tablescatalog entities if needed by underlying services.
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:database/*`,
              $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:table/*/*`,
            ],
          },
          {
            sid: "S3DeliveryErrorBucketPermission",
            effect: "Allow",
            actions: [
              "s3:AbortMultipartUpload",
              "s3:GetBucketLocation",
              "s3:GetObject",
              "s3:ListBucket",
              "s3:ListBucketMultipartUploads",
              "s3:PutObject",
            ],
            resources: [
              backupS3Bucket.arn,
              $interpolate`${backupS3Bucket.arn}/*`,
            ],
          },
          {
            sid: "RequiredWhenDoingMetadataReadsANDDataAndMetadataWriteViaLakeformation",
            effect: "Allow",
            actions: ["lakeformation:GetDataAccess"],
            resources: ["*"], // As per AWS documentation for Firehose to S3 Tables
          },
          // Optional: CloudWatch Logs permissions
           {
             sid: "LoggingInCloudWatch",
             effect: "Allow",
             actions: ["logs:PutLogEvents"],
             resources: [$interpolate`arn:${partition.partition}:logs:${region.name}:${accountId}:log-group:/aws/kinesisfirehose/${firehoseStreamName}:*`],
           },
        ],
    });

    const firehosePolicy = new aws.iam.Policy("firehosePolicy", {
      name: `${baseName}-FirehoseS3TablesPolicy`,
      description: "Policy for Firehose to access S3 Tables via Glue/Lake Formation and S3 for backups.",
      policy: firehosePolicyDocument.json,
    });

    new aws.iam.RolePolicyAttachment("firehoseRolePolicyAttachment", {
      role: firehoseRole.name,
      policyArn: firehosePolicy.arn,
    });

    // 4. Glue Resource Link to the S3 Table Namespace
    // Construct the database name for the S3 Table Namespace within the s3tablescatalog.
    // This follows the pattern: <S3_TABLE_BUCKET_NAME>/<NAMESPACE_NAME>
    const s3TableNamespaceDatabaseNameInS3TablesCatalog = $interpolate`${s3TableBucket.name}/${s3TableNamespace.namespace}`;

    // This is the fully qualified name of the S3 Table namespace as it appears in the default Glue catalog for Lake Formation.
    // It refers to the path within s3tablescatalog, which itself is specified as the target catalog in s3TableNamespaceLink.
    // const lfS3TableDbName_OLD = $interpolate`s3tablescatalog/${s3TableNamespaceDatabaseNameInS3TablesCatalog}`;

    // Corrected path for direct use with s3tablescatalog as catalogId
    const s3TableDbPathInS3TablesCatalog = $interpolate`${s3TableBucket.name}/${s3TableNamespace.namespace}`;

    // 4. Glue Resource Link to the S3 Table Namespace (via AWS CLI)
    const s3TableNamespaceLink = new command.local.Command("s3TableNamespaceLink", {
      create: $interpolate`aws glue create-database --database-input '{
        "Name": "${firehoseResourceLinkName}",
        "TargetDatabase": {
          "CatalogId": "${accountId}:s3tablescatalog/${s3TableBucket.name}",
          "DatabaseName": "${s3TableNamespace.namespace}"
        }
      }'`,
      delete: $interpolate`aws glue delete-database --name ${firehoseResourceLinkName}`,
    }, { dependsOn: [s3TableBucket, s3TableNamespace] });

    // 5. Lake Formation Permissions (via AWS CLI)
    const lfPermDb = new command.local.Command("LfPermDb", {
        create: $interpolate`aws lakeformation grant-permissions --principal DataLakePrincipalIdentifier='${firehoseRole.arn}' --permissions '["DESCRIBE"]' --resource '{
        "Database": {
          "CatalogId": "${accountId}:s3tablescatalog/${s3TableBucket.name}",
          "Name": "${s3TableNamespace.namespace}"
        }
      }'`,
        delete: $interpolate`aws lakeformation revoke-permissions --principal DataLakePrincipalIdentifier='${firehoseRole.arn}' --permissions '["DESCRIBE"]' --resource '{
        "Database": {
          "CatalogId": "${accountId}:s3tablescatalog/${s3TableBucket.name}",
          "Name": "${s3TableNamespace.namespace}"
        }
      }'`,
    }, { dependsOn: [firehoseRole, s3TableNamespace, s3TableBucket] });

    const lfPermTable = new command.local.Command("LfPermTable", {
        create: $interpolate`aws lakeformation grant-permissions --principal DataLakePrincipalIdentifier='${firehoseRole.arn}' --permissions '["SELECT", "INSERT", "ALTER", "DESCRIBE"]' --resource '{
        "Table": {
          "CatalogId": "${accountId}:s3tablescatalog/${s3TableBucket.name}",
          "DatabaseName": "${s3TableNamespace.namespace}",
          "Name": "${s3Table.name}"
        }
      }'`,
        delete: $interpolate`aws lakeformation revoke-permissions --principal DataLakePrincipalIdentifier='${firehoseRole.arn}' --permissions '["SELECT", "INSERT", "ALTER", "DESCRIBE"]' --resource '{
        "Table": {
          "CatalogId": "${accountId}:s3tablescatalog/${s3TableBucket.name}",
          "DatabaseName": "${s3TableNamespace.namespace}",
          "Name": "${s3Table.name}"
        }
      }'`,
    }, { dependsOn: [firehoseRole, s3Table, lfPermDb] });

    // 6. Kinesis Firehose Delivery Stream
    const firehoseDeliveryStream = new aws.kinesis.FirehoseDeliveryStream("firehoseDeliveryStream", {
      name: firehoseStreamName,
      destination: "iceberg",
      icebergConfiguration: {
        roleArn: firehoseRole.arn,
        catalogArn: $interpolate`arn:${partition.partition}:glue:${region.name}:${accountId}:catalog`, // Firehose uses the default Glue catalog where the link is
        s3Configuration: {
          roleArn: firehoseRole.arn,
          bucketArn: backupS3Bucket.arn,
          bufferingInterval: 300,
          bufferingSize: 5, // MB
          // compressionFormat: "GZIP", // Optional backup compression
          cloudwatchLoggingOptions: { // Logging for S3 backup part
            enabled: true,
            logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseStreamName}-backupS3`,
            logStreamName: "S3Delivery",
          }
        },
        destinationTableConfigurations: [{
          databaseName: firehoseResourceLinkName, // Firehose targets the *resource link name* as the database
          tableName: s3Table.name, // And the S3 table name within that logical DB (link)
        }],
        // Optional: processingConfiguration for Lambda transformations or JQ parsing
        // processingConfiguration: {
        //     enabled: true,
        //     processors: [{...}]
        // }
      },
      // cloudwatchLoggingOptions: { // Logging for the main Firehose stream
      //     enabled: true,
      //     logGroupName: $interpolate`/aws/kinesisfirehose/${firehoseStreamName}`,
      //     logStreamName: "DestinationDelivery",
      // },
    }, {
      dependsOn: [
        lfPermTable,
        firehoseRole,
        backupS3Bucket,
        s3TableNamespaceLink,
      ],
    });

    return {
      s3TableBucketArn: s3TableBucket.arn,
      s3TableBucketName: s3TableBucket.name,
      s3TableNamespaceName: s3TableNamespace.namespace,
      s3TableName: s3Table.name,
      firehoseRoleArn: firehoseRole.arn,
      glueResourceLinkName: firehoseResourceLinkName,
      firehoseBackupS3BucketName: backupS3Bucket.bucket,
      firehoseDeliveryStreamName: firehoseDeliveryStream.name,
      firehoseDeliveryStreamArn: firehoseDeliveryStream.arn,
    };
  },
});