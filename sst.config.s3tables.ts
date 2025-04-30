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

export default $config({
  app(input) {
    return {
      name: "topupanalytics",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {command: "1.0.2"},
    };
  },
  async run() {
    const isProd = $app.stage === "production";
    const accountId = aws.getCallerIdentityOutput({}).accountId;
    const region = aws.getRegionOutput({}).name;
    const partition = aws.getPartitionOutput({}).partition; // Needed for ARN construction
    // Define basename early and use consistently for resource naming
    const basename = `${$app.name}${$app.stage}`;

    const s3TableBucket = new aws.s3tables.TableBucket("S3TableBucket", {
      name: "s3table-bucket"
    });
    const s3TableNamespace = new aws.s3tables.Namespace("S3TableNamespace", {
      namespace: "s3table_namespace",
      tableBucketArn: s3TableBucket.arn,
    });
    const s3Table = new aws.s3tables.Table("S3Table", {
      name: "s3table",
      namespace: s3TableNamespace.namespace,
      tableBucketArn: s3TableNamespace.tableBucketArn,
      format: "ICEBERG",
    });
    const s3TableGlue = new aws.glue.CatalogDatabase(`S3TableCatalogDb`, {
      name: `s3table_catalog_db`, // Use explicit name
      // catalogId: "what_goes_here",
      targetDatabase: {
        catalogId: $interpolate`${accountId}:s3tablescatalog/${s3TableBucket.name}`,
        databaseName: s3Table.name
      }
    })

    // The firehoseDeliveryRole likely needs to have LakeFormation permissions
    const s3TableFirehose = new aws.kinesis.FirehoseDeliveryStream("S3TableFirehose", {
      name: "s3-table-firehose",
      destination: "iceberg",
      tags: {
        Environment: $app.stage,
        Project: $app.name,
        Table: 's3table',
      },

      icebergConfiguration: {
        roleArn: firehoseDeliveryRole.arn, // Role Firehose assumes for access
        // catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:s3tablescatalog`,
        catalogArn: $interpolate`arn:${partition}:glue:${region}:${accountId}:catalog`,
        bufferingInterval: 60, // Seconds (e.g., 60-900)
        bufferingSize: 64, // MBs (e.g., 64-128)
        s3Configuration: {
          roleArn: firehoseDeliveryRole.arn,
          bucketArn: s3Table.arn, // Bucket where Iceberg data/metadata resides
          // errorOutputPrefix: $interpolate`iceberg-errors/${tableName}/result=!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/!{firehose:random-string}/`,
        },
        destinationTableConfigurations: [{
          databaseName: s3TableGlue.name,
          tableName: s3Table.name, // glueTable.name,
        }],
      },
    })
  }
});