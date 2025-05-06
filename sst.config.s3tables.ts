/// <reference path="./.sst/platform/config.d.ts" />

/*
TODO S3 Tables.
Eventually replace sst.config.ts S3+Glue+Firehose manual Iceberg config with S3Tables.
Currently S3Tables has minimal Pulumi integration. With Pulumi, can create:
1. s3TableBucket
1. s3TableNamespace
1. s3Table

Then must manually:
## "Enable Integration"
Enable integration with AWS Analytics service, button-click in Console.
This creates new IAM service role, called S3TablesRoleForLakeFormation, in your account, and attaches a policy to the role called S3TablesPolicyForLakeFormation. This role allows Lake Formation to register all table buckets in this AWS Region as data locations.
Then AWS Glue creates a new catalog, the s3tablescatalog, in the AWS Glue Data Catalog.
The s3tablescatalog automatically populates any new S3 Table buckets you create in this Region as new sub-catalogs. Additionally, any namespaces or tables within a table bucket are also automatically populated as databases and tables within their respective sub-catalogs.

## Create a resource link to table's namespace
https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html
*/

/**
 * Pulumi stack (TypeScript, us-east-1) that delivers Kinesis->Firehose
 * records into an Amazon S3 Table (Iceberg) AFTER you’ve already clicked
 * “Enable Integration with AWS Analytics Services” in the console.
 *
 * Assumptions: The console click created
 * – IAM role `S3TablesRoleForLakeFormation`
 * – Glue federated catalog `s3tablescatalog`
 * – Lake Formation registration for all S3-table buckets
 */

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
    const basename = `${$app.name}${$app.stage}`;

    /* ---------------------------------------------------------
     * 1. S3 Table bucket (+ namespace + table)
     * ------------------------------------------------------- */
    const tableBucket = new aws.s3tables.TableBucket("tblBucket", {
      name: "my-analytics-tbl-bucket",
    });

    const namespace = new aws.s3tables.Namespace("salesNs", {
      tableBucketArn: tableBucket.arn,
      namespace: "sales_data_ns",
    });
    
    const table = new aws.s3tables.Table("txnTbl", {
      tableBucketArn: tableBucket.arn,
      namespace: namespace.namespace,
      name: "transactions",
      format: "ICEBERG",
    });
    
    /* ---------------------------------------------------------
     * 2. Resource-link DB in the *default* Glue catalog
     * ------------------------------------------------------- */
    const nsLink = new aws.glue.CatalogDatabase("salesNsLink", {
      catalogId: accountId,
      name: "sales_data_ns_link",
      targetDatabase: {
        catalogId: $interpolate`${accountId}:s3tablescatalog/${tableBucket.name}`,
        databaseName: namespace.namespace,
      },
      createTableDefaultPermissions: [],
    });

    /* ---------------------------------------------------------
     * 3. Firehose service role
     * ------------------------------------------------------- */
    const firehoseRole = new aws.iam.Role("firehoseRole", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "firehose.amazonaws.com",
      }),
    });
    

    new aws.iam.RolePolicy("firehoseRolePolicy", {
      role: firehoseRole.id,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "GlueCatalogAccess",
            Effect: "Allow",
            Action: [
              "glue:GetDatabase",
              "glue:GetTable",
              "glue:GetTableVersion",
              "glue:UpdateTable"
            ],
            Resource: [
              // Catalog
              `arn:aws:glue:${region}:${accountId}:catalog`,
              // Linked database
              `arn:aws:glue:${region}:${accountId}:database/sales_data_ns_link`,
              // Linked table
              `arn:aws:glue:${region}:${accountId}:table/sales_data_ns_link/transactions`
            ]
          },
          {
            Sid: "LakeFormationAccess",
            Effect: "Allow",
            Action: ["lakeformation:GetDataAccess"],
            Resource: "*",
          },
          {
            Sid: "S3PutForErrors",
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListBucket"],
            Resource: [
              "arn:aws:s3:::my-firehose-error-bucket",
              "arn:aws:s3:::my-firehose-error-bucket/*",
            ],
          },
        ],
      })
    });
    
    /* ---------------------------------------------------------
     * 4. Lake Formation grants to Firehose role
     * ------------------------------------------------------- */
    // DESCRIBE on the linked database
    new aws.lakeformation.Permissions("fhLinkDescribe", {
      principal: firehoseRole.arn,
      permissions: ["DESCRIBE"],
      database: { name: nsLink.name, catalogId: accountId },
    });

    /* ---------------------------------------------------------
     * 5. Firehose delivery stream → Iceberg
     * ------------------------------------------------------- */
    const stagingBucket = new aws.s3.Bucket("firehoseStaging", {
      bucket: "my-analytics-firehose-staging",
      forceDestroy: true,
    });
    const fh = new aws.kinesis.FirehoseDeliveryStream("icebergStream", {
      destination: "iceberg",
      icebergConfiguration: {
        roleArn:    firehoseRole.arn,
        catalogArn: $interpolate`arn:aws:glue:${region}:${accountId}:catalog`,
        s3Configuration: {
          roleArn:   firehoseRole.arn,
          bucketArn: stagingBucket.arn,   // ← must be a real S3 bucket ARN :contentReference[oaicite:2]{index=2}
          bufferingInterval: 300,
          bufferingSize:     64,
        },
        destinationTableConfigurations: [{
          databaseName: nsLink.name,
          tableName:    table.name,
        }],
      },
    }, { dependsOn: [nsLink, table] });

    const grantTable = new command.local.Command("grantIcebergTable", {
      create: $interpolate`aws lakeformation grant-permissions \
          --principal DataLakePrincipalIdentifier=${firehoseRole.arn} \
          --permissions INSERT,DELETE \
          --resource '{"Table":{"CatalogId":"${accountId}:s3tablescatalog/${tableBucket.name}","DatabaseName":"${namespace.namespace}","Name":"${table.name}"}}'`,
      delete: $interpolate`aws lakeformation revoke-permissions \
          --principal DataLakePrincipalIdentifier=${firehoseRole.arn} \
          --permissions INSERT,DELETE \
          --resource '{"Table":{"CatalogId":"${accountId}:s3tablescatalog/${tableBucket.name}","DatabaseName":"${namespace.namespace}","Name":"${table.name}"}}'`,
    }, { dependsOn: [fh] });

  }
});