Extended S3 Destination

```
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const bucket = new aws.s3.BucketV2("bucket", {bucket: "tf-test-bucket"});
const firehoseAssumeRole = aws.iam.getPolicyDocument({
    statements: [{
        effect: "Allow",
        principals: [{
            type: "Service",
            identifiers: ["firehose.amazonaws.com"],
        }],
        actions: ["sts:AssumeRole"],
    }],
});
const firehoseRole = new aws.iam.Role("firehose_role", {
    name: "firehose_test_role",
    assumeRolePolicy: firehoseAssumeRole.then(firehoseAssumeRole => firehoseAssumeRole.json),
});
const lambdaAssumeRole = aws.iam.getPolicyDocument({
    statements: [{
        effect: "Allow",
        principals: [{
            type: "Service",
            identifiers: ["lambda.amazonaws.com"],
        }],
        actions: ["sts:AssumeRole"],
    }],
});
const lambdaIam = new aws.iam.Role("lambda_iam", {
    name: "lambda_iam",
    assumeRolePolicy: lambdaAssumeRole.then(lambdaAssumeRole => lambdaAssumeRole.json),
});
const lambdaProcessor = new aws.lambda.Function("lambda_processor", {
    code: new pulumi.asset.FileArchive("lambda.zip"),
    name: "firehose_lambda_processor",
    role: lambdaIam.arn,
    handler: "exports.handler",
    runtime: aws.lambda.Runtime.NodeJS20dX,
});
const extendedS3Stream = new aws.kinesis.FirehoseDeliveryStream("extended_s3_stream", {
    name: "kinesis-firehose-extended-s3-test-stream",
    destination: "extended_s3",
    extendedS3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: bucket.arn,
        processingConfiguration: {
            enabled: true,
            processors: [{
                type: "Lambda",
                parameters: [{
                    parameterName: "LambdaArn",
                    parameterValue: pulumi.interpolate`${lambdaProcessor.arn}:$LATEST`,
                }],
            }],
        },
    },
});
const bucketAcl = new aws.s3.BucketAclV2("bucket_acl", {
    bucket: bucket.id,
    acl: "private",
});
```

Extended S3 Destination with dynamic partitioning. These examples use built-in Firehose functionality, rather than requiring a lambda.
```
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const extendedS3Stream = new aws.kinesis.FirehoseDeliveryStream("extended_s3_stream", {
    name: "kinesis-firehose-extended-s3-test-stream",
    destination: "extended_s3",
    extendedS3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: bucket.arn,
        bufferingSize: 64,
        dynamicPartitioningConfiguration: {
            enabled: true,
        },
        prefix: "data/customer_id=!{partitionKeyFromQuery:customer_id}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/",
        errorOutputPrefix: "errors/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/!{firehose:error-output-type}/",
        processingConfiguration: {
            enabled: true,
            processors: [
                {
                    type: "RecordDeAggregation",
                    parameters: [{
                        parameterName: "SubRecordType",
                        parameterValue: "JSON",
                    }],
                },
                {
                    type: "AppendDelimiterToRecord",
                },
                {
                    type: "MetadataExtraction",
                    parameters: [
                        {
                            parameterName: "JsonParsingEngine",
                            parameterValue: "JQ-1.6",
                        },
                        {
                            parameterName: "MetadataExtractionQuery",
                            parameterValue: "{customer_id:.customer_id}",
                        },
                    ],
                },
            ],
        },
    },
});
```
The following example adds the Dynamic Partitioning Keys: store_id and customer_id to the S3 prefix.
```
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const extendedS3Stream = new aws.kinesis.FirehoseDeliveryStream("extended_s3_stream", {
    name: "kinesis-firehose-extended-s3-test-stream",
    destination: "extended_s3",
    extendedS3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: bucket.arn,
        bufferingSize: 64,
        dynamicPartitioningConfiguration: {
            enabled: true,
        },
        prefix: "data/store_id=!{partitionKeyFromQuery:store_id}/customer_id=!{partitionKeyFromQuery:customer_id}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/",
        errorOutputPrefix: "errors/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/!{firehose:error-output-type}/",
        processingConfiguration: {
            enabled: true,
            processors: [{
                type: "MetadataExtraction",
                parameters: [
                    {
                        parameterName: "JsonParsingEngine",
                        parameterValue: "JQ-1.6",
                    },
                    {
                        parameterName: "MetadataExtractionQuery",
                        parameterValue: "{store_id:.store_id,customer_id:.customer_id}",
                    },
                ],
            }],
        },
    },
});
```

Iceberg Destination
```
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
```

FirehoseDeliveryStream Resource Properties
To learn more about resource properties and how to use them, see Inputs and Outputs in the Architecture and Concepts docs.

Inputs
The FirehoseDeliveryStream resource accepts the following input properties:

destination 
This property is required.
Changes to this property will trigger replacement.
string
This is the destination to where the data is delivered. The only options are s3 (Deprecated, use extended_s3 instead), extended_s3, redshift, elasticsearch, splunk, http_endpoint, opensearch, opensearchserverless and snowflake.
arn
string
The Amazon Resource Name (ARN) specifying the Stream
destinationId
string
elasticsearchConfiguration
FirehoseDeliveryStreamElasticsearchConfiguration
Configuration options when destination is elasticsearch. See elasticsearch_configuration block below for details.
extendedS3Configuration
FirehoseDeliveryStreamExtendedS3Configuration
Enhanced configuration options for the s3 destination. See extended_s3_configuration block below for details.
httpEndpointConfiguration
FirehoseDeliveryStreamHttpEndpointConfiguration
Configuration options when destination is http_endpoint. Requires the user to also specify an s3_configuration block. See http_endpoint_configuration block below for details.
icebergConfiguration
FirehoseDeliveryStreamIcebergConfiguration
Configuration options when destination is iceberg. See iceberg_configuration block below for details.
kinesisSourceConfiguration Changes to this property will trigger replacement.
FirehoseDeliveryStreamKinesisSourceConfiguration
The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See kinesis_source_configuration block below for details.
mskSourceConfiguration Changes to this property will trigger replacement.
FirehoseDeliveryStreamMskSourceConfiguration
The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See msk_source_configuration block below for details.
name Changes to this property will trigger replacement.
string
A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with aws-waf-logs-. See AWS Documentation for more details.
opensearchConfiguration
FirehoseDeliveryStreamOpensearchConfiguration
Configuration options when destination is opensearch. See opensearch_configuration block below for details.
opensearchserverlessConfiguration
FirehoseDeliveryStreamOpensearchserverlessConfiguration
Configuration options when destination is opensearchserverless. See opensearchserverless_configuration block below for details.
redshiftConfiguration
FirehoseDeliveryStreamRedshiftConfiguration
Configuration options when destination is redshift. Requires the user to also specify an s3_configuration block. See redshift_configuration block below for details.
serverSideEncryption
FirehoseDeliveryStreamServerSideEncryption
Encrypt at rest options. See server_side_encryption block below for details.

NOTE: Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

snowflakeConfiguration
FirehoseDeliveryStreamSnowflakeConfiguration
Configuration options when destination is snowflake. See snowflake_configuration block below for details.
splunkConfiguration
FirehoseDeliveryStreamSplunkConfiguration
Configuration options when destination is splunk. See splunk_configuration block below for details.
tags
{[key: string]: string}
A map of tags to assign to the resource. If configured with a provider default_tags configuration block present, tags with matching keys will overwrite those defined at the provider-level.
versionId
string
Outputs
All input properties are implicitly available as output properties. Additionally, the FirehoseDeliveryStream resource produces the following output properties:

id
string
The provider-assigned unique ID for this managed resource.
tagsAll
{[key: string]: string}
A map of tags assigned to the resource, including those inherited from the provider default_tags configuration block.
Deprecated: Please use tags instead.

FirehoseDeliveryStream Resource Properties
To learn more about resource properties and how to use them, see Inputs and Outputs in the Architecture and Concepts docs.

Inputs
The FirehoseDeliveryStream resource accepts the following input properties:

destination 
This property is required.
Changes to this property will trigger replacement.
string
This is the destination to where the data is delivered. The only options are s3 (Deprecated, use extended_s3 instead), extended_s3, redshift, elasticsearch, splunk, http_endpoint, opensearch, opensearchserverless and snowflake.
arn
string
The Amazon Resource Name (ARN) specifying the Stream
destinationId
string
elasticsearchConfiguration
FirehoseDeliveryStreamElasticsearchConfiguration
Configuration options when destination is elasticsearch. See elasticsearch_configuration block below for details.
extendedS3Configuration
FirehoseDeliveryStreamExtendedS3Configuration
Enhanced configuration options for the s3 destination. See extended_s3_configuration block below for details.
httpEndpointConfiguration
FirehoseDeliveryStreamHttpEndpointConfiguration
Configuration options when destination is http_endpoint. Requires the user to also specify an s3_configuration block. See http_endpoint_configuration block below for details.
icebergConfiguration
FirehoseDeliveryStreamIcebergConfiguration
Configuration options when destination is iceberg. See iceberg_configuration block below for details.
kinesisSourceConfiguration Changes to this property will trigger replacement.
FirehoseDeliveryStreamKinesisSourceConfiguration
The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See kinesis_source_configuration block below for details.
mskSourceConfiguration Changes to this property will trigger replacement.
FirehoseDeliveryStreamMskSourceConfiguration
The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See msk_source_configuration block below for details.
name Changes to this property will trigger replacement.
string
A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with aws-waf-logs-. See AWS Documentation for more details.
opensearchConfiguration
FirehoseDeliveryStreamOpensearchConfiguration
Configuration options when destination is opensearch. See opensearch_configuration block below for details.
opensearchserverlessConfiguration
FirehoseDeliveryStreamOpensearchserverlessConfiguration
Configuration options when destination is opensearchserverless. See opensearchserverless_configuration block below for details.
redshiftConfiguration
FirehoseDeliveryStreamRedshiftConfiguration
Configuration options when destination is redshift. Requires the user to also specify an s3_configuration block. See redshift_configuration block below for details.
serverSideEncryption
FirehoseDeliveryStreamServerSideEncryption
Encrypt at rest options. See server_side_encryption block below for details.

NOTE: Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

snowflakeConfiguration
FirehoseDeliveryStreamSnowflakeConfiguration
Configuration options when destination is snowflake. See snowflake_configuration block below for details.
splunkConfiguration
FirehoseDeliveryStreamSplunkConfiguration
Configuration options when destination is splunk. See splunk_configuration block below for details.
tags
{[key: string]: string}
A map of tags to assign to the resource. If configured with a provider default_tags configuration block present, tags with matching keys will overwrite those defined at the provider-level.
versionId
string
Outputs
All input properties are implicitly available as output properties. Additionally, the FirehoseDeliveryStream resource produces the following output properties:

id
string
The provider-assigned unique ID for this managed resource.
tagsAll
{[key: string]: string}
A map of tags assigned to the resource, including those inherited from the provider default_tags configuration block.
Deprecated: Please use tags instead.