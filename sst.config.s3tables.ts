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
   In the S3 console, this might be under an "Application integration" tab when viewing S3 features.
3. Enable this integration.

What this manual action does:
This step provisions necessary background resources required by S3 Tables, which typically include:
  - A Glue Data Catalog database (which acts as a catalog) named `s3tablescatalog`.
  - An IAM Role, often named `S3TablesRoleForLakeFormation` (or similar).
  - An IAM Policy, often named `S3TablesPolicyForLakeFormation` (or similar).

CRITICAL WARNING:
Failure to complete this manual setup BEFORE deploying the stack will likely result in deployment
errors. These errors may occur when Pulumi attempts to create S3 Tables resources, Glue Resource
Links to S3 Table namespaces, or related Lake Formation permissions. Common errors include
"Catalog not found" (referring to `s3tablescatalog`) or permission issues related to accessing
or configuring resources within `s3tablescatalog`.

Please ensure this prerequisite is met to avoid deployment failures.
====================================================================================================
*/
/// <reference path="./.sst/platform/config.d.ts" />

// Prerequisite: Manually enable S3 Tables integration with AWS Analytics Services
// in the AWS console for the target region *before running this stack*.
// This action creates the 's3tablescatalog' in AWS Glue and the necessary
// 'S3TablesRoleForLakeFormation' IAM role and 'S3TablesPolicyForLakeFormation' policy.

export default $config({
  app(input) {
    return {
      name: "s3tablestest",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage ?? ''),
      home: "aws",
      providers: { aws: true }, // Assuming SST handles provider configuration
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
    // This follows the pattern: <ACCOUNTID>_<S3_TABLE_BUCKET_NAME>/<NAMESPACE_NAME>
    const s3TableNamespaceDatabaseNameInS3TablesCatalog = $interpolate`${accountId}_${s3TableBucket.name}/${s3TableNamespace.namespace}`;

    const s3TableNamespaceLink = new aws.glue.CatalogDatabase("s3TableNamespaceLink", {
      name: firehoseResourceLinkName,
      catalogId: accountId, // Link created in the default account catalog
      targetDatabase: {
        catalogId: "s3tablescatalog", // Target the top-level s3tablescatalog
        databaseName: s3TableNamespaceDatabaseNameInS3TablesCatalog, // Full path to namespace within s3tablescatalog
        // region: region.name, // Only specify if target is in different region
      },
      // createTableDefaultPermissions: [] // Not directly applicable here, manage via LF
    }, { dependsOn: [s3TableBucket, s3TableNamespace] });

    // 5. Lake Formation Permissions

    // 5. Lake Formation Permissions

     // 5.1. Grant Firehose role DESCRIBE on the resource link itself
    const lfPermOnResourceLink = new aws.lakeformation.Permissions("lfPermOnResourceLink", {
      principal: firehoseRole.arn,
      permissions: ["DESCRIBE"],
      database: {
        catalogId: accountId, // Link resides in the default account catalog
        name: s3TableNamespaceLink.name, // Name of the resource link
      },
    }, { dependsOn: [firehoseRole, s3TableNamespaceLink] });

    // 5.2. Grant Firehose role permissions on the *target* S3 Table Namespace
    const lfPermOnTargetNamespace = new aws.lakeformation.Permissions("lfPermOnTargetNamespace", {
      principal: firehoseRole.arn,
      permissions: ["DESCRIBE", "ALTER", "CREATE_TABLE", "DROP"],
      database: {
        catalogId: "s3tablescatalog", // Target the top-level s3tablescatalog
        name: s3TableNamespaceDatabaseNameInS3TablesCatalog, // Full path to namespace within s3tablescatalog
      },
    }, { dependsOn: [firehoseRole, s3TableNamespace, s3TableBucket, s3TableNamespaceLink] });

    // 5.3. Grant Firehose role permissions on the *target* S3 Table
    const lfPermOnTargetTable = new aws.lakeformation.Permissions("lfPermOnTargetTable", {
      principal: firehoseRole.arn,
      permissions: ["SELECT", "INSERT", "DELETE", "DESCRIBE", "ALTER"],
      table: {
        catalogId: "s3tablescatalog", // Target the top-level s3tablescatalog
        databaseName: s3TableNamespaceDatabaseNameInS3TablesCatalog, // Full path to namespace within s3tablescatalog
        name: s3Table.name,                               // The S3 Table name
      },
    }, { dependsOn: [firehoseRole, s3Table, lfPermOnTargetNamespace] });

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
          databaseName: s3TableNamespaceLink.name, // Firehose targets the *resource link name* as the database
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
        lfPermOnResourceLink,
        lfPermOnTargetNamespace,
        lfPermOnTargetTable,
        firehoseRole, // Role and policy attachment implicitly handled by using firehoseRole.arn
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
      glueResourceLinkName: s3TableNamespaceLink.name,
      firehoseBackupS3BucketName: backupS3Bucket.bucket,
      firehoseDeliveryStreamName: firehoseDeliveryStream.name,
      firehoseDeliveryStreamArn: firehoseDeliveryStream.arn,
    };
  },
});