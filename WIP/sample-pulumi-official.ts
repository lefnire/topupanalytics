import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const current = aws.getCallerIdentity({});
const currentGetPartition = aws.getPartition({});
const currentGetRegion = aws.getRegion({});
const bucket = new aws.s3.BucketV2("bucket", {
    bucket: "test-bucket",
    forceDestroy: true,
});
const test = new aws.glue.CatalogDatabase("test", {name: "test"});
const testCatalogTable = new aws.glue.CatalogTable("test", {
    name: "test",
    databaseName: test.name,
    parameters: {
        format: "parquet",
    },
    tableType: "EXTERNAL_TABLE",
    openTableFormatInput: {
        icebergInput: {
            metadataOperation: "CREATE",
            version: "2",
        },
    },
    storageDescriptor: {
        location: pulumi.interpolate`s3://${bucket.id}`,
        columns: [{
            name: "my_column_1",
            type: "int",
        }],
    },
});
const testStream = new aws.kinesis.FirehoseDeliveryStream("test_stream", {
    name: "kinesis-firehose-test-stream",
    destination: "iceberg",
    icebergConfiguration: {
        roleArn: firehoseRole.arn,
        catalogArn: Promise.all([currentGetPartition, currentGetRegion, current]).then(([currentGetPartition, currentGetRegion, current]) => `arn:${currentGetPartition.partition}:glue:${currentGetRegion.name}:${current.accountId}:catalog`),
        bufferingSize: 10,
        bufferingInterval: 400,
        s3Configuration: {
            roleArn: firehoseRole.arn,
            bucketArn: bucket.arn,
        },
        destinationTableConfigurations: [{
            databaseName: test.name,
            tableName: testCatalogTable.name,
        }],
        processingConfiguration: {
            enabled: true,
            processors: [{
                type: "Lambda",
                parameters: [{
                    parameterName: "LambdaArn",
                    parameterValue: `${lambdaProcessor.arn}:$LATEST`,
                }],
            }],
        },
    },
});