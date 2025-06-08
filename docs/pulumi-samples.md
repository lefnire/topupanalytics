# Basic Glue Database & Delivery Stream

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

---

# Firehose Pulumi Docs

Provides a Kinesis Firehose Delivery Stream resource. Amazon Kinesis Firehose is a fully managed, elastic service to easily deliver real-time data streams to destinations such as Amazon S3 , Amazon Redshift and Snowflake.

For more details, see the [Amazon Kinesis Firehose Documentation](https://aws.amazon.com/documentation/firehose/).

Example Usage
-------------

### Extended S3 Destination

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


### Extended S3 Destination with dynamic partitioning

These examples use built-in Firehose functionality, rather than requiring a lambda.

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



Multiple Dynamic Partitioning Keys (maximum of 50) can be added by comma separating the `parameter_value`.

The following example adds the Dynamic Partitioning Keys: `store_id` and `customer_id` to the S3 prefix.

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



### Iceberg Destination

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



Create FirehoseDeliveryStream Resource
--------------------------------------

Resources are created with functions called constructors. To learn more about declaring and configuring resources, see [Resources](https://www.pulumi.com/docs/concepts/resources/).

### Constructor syntax

```
new FirehoseDeliveryStream(name: string, args: FirehoseDeliveryStreamArgs, opts?: CustomResourceOptions);
```


```
@overload
def FirehoseDeliveryStream(resource_name: str,
                           args: FirehoseDeliveryStreamArgs,
                           opts: Optional[ResourceOptions] = None)

@overload
def FirehoseDeliveryStream(resource_name: str,
                           opts: Optional[ResourceOptions] = None,
                           destination: Optional[str] = None,
                           msk_source_configuration: Optional[FirehoseDeliveryStreamMskSourceConfigurationArgs] = None,
                           opensearch_configuration: Optional[FirehoseDeliveryStreamOpensearchConfigurationArgs] = None,
                           elasticsearch_configuration: Optional[FirehoseDeliveryStreamElasticsearchConfigurationArgs] = None,
                           extended_s3_configuration: Optional[FirehoseDeliveryStreamExtendedS3ConfigurationArgs] = None,
                           http_endpoint_configuration: Optional[FirehoseDeliveryStreamHttpEndpointConfigurationArgs] = None,
                           iceberg_configuration: Optional[FirehoseDeliveryStreamIcebergConfigurationArgs] = None,
                           kinesis_source_configuration: Optional[FirehoseDeliveryStreamKinesisSourceConfigurationArgs] = None,
                           arn: Optional[str] = None,
                           destination_id: Optional[str] = None,
                           opensearchserverless_configuration: Optional[FirehoseDeliveryStreamOpensearchserverlessConfigurationArgs] = None,
                           name: Optional[str] = None,
                           redshift_configuration: Optional[FirehoseDeliveryStreamRedshiftConfigurationArgs] = None,
                           server_side_encryption: Optional[FirehoseDeliveryStreamServerSideEncryptionArgs] = None,
                           snowflake_configuration: Optional[FirehoseDeliveryStreamSnowflakeConfigurationArgs] = None,
                           splunk_configuration: Optional[FirehoseDeliveryStreamSplunkConfigurationArgs] = None,
                           tags: Optional[Mapping[str, str]] = None,
                           version_id: Optional[str] = None)
```


```
func NewFirehoseDeliveryStream(ctx *Context, name string, args FirehoseDeliveryStreamArgs, opts ...ResourceOption) (*FirehoseDeliveryStream, error)
```


```
public FirehoseDeliveryStream(string name, FirehoseDeliveryStreamArgs args, CustomResourceOptions? opts = null)
```


```
public FirehoseDeliveryStream(String name, FirehoseDeliveryStreamArgs args)
public FirehoseDeliveryStream(String name, FirehoseDeliveryStreamArgs args, CustomResourceOptions options)

```


```
type: aws:kinesis:FirehoseDeliveryStream
properties: # The arguments to resource properties.
options: # Bag of options to control resource's behavior.


```


#### Parameters

name string

The unique name of the resource.

args [FirehoseDeliveryStreamArgs](#inputs)

The arguments to resource properties.

opts [CustomResourceOptions](https://www.pulumi.com/docs/reference/pkg/nodejs/pulumi/pulumi/#CustomResourceOptions)

Bag of options to control resource's behavior.

resource\_name str

The unique name of the resource.

args [FirehoseDeliveryStreamArgs](#inputs)

The arguments to resource properties.

opts [ResourceOptions](https://www.pulumi.com/docs/reference/pkg/python/pulumi/#pulumi.ResourceOptions)

Bag of options to control resource's behavior.

ctx [Context](https://pkg.go.dev/github.com/pulumi/pulumi/sdk/v3/go/pulumi?tab=doc#Context)

Context object for the current deployment.

name string

The unique name of the resource.

args [FirehoseDeliveryStreamArgs](#inputs)

The arguments to resource properties.

opts [ResourceOption](https://pkg.go.dev/github.com/pulumi/pulumi/sdk/v3/go/pulumi?tab=doc#ResourceOption)

Bag of options to control resource's behavior.

name string

The unique name of the resource.

args [FirehoseDeliveryStreamArgs](#inputs)

The arguments to resource properties.

opts [CustomResourceOptions](https://www.pulumi.com/docs/reference/pkg/dotnet/Pulumi/Pulumi.CustomResourceOptions.html)

Bag of options to control resource's behavior.

name String

The unique name of the resource.

args [FirehoseDeliveryStreamArgs](#inputs)

The arguments to resource properties.

options CustomResourceOptions

Bag of options to control resource's behavior.



FirehoseDeliveryStream Resource Properties
------------------------------------------

To learn more about resource properties and how to use them, see [Inputs and Outputs](https://www.pulumi.com/docs/intro/concepts/inputs-outputs) in the Architecture and Concepts docs.

### Inputs

In Python, inputs that are objects can be passed either as [argument classes or as dictionary literals](https://www.pulumi.com/docs/languages-sdks/python/#inputs-and-outputs).

The FirehoseDeliveryStream resource accepts the following [input](https://www.pulumi.com/docs/intro/concepts/inputs-outputs) properties:

[Destination](#destination_csharp) string

This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extended_s3` instead), `extended_s3`, `redshift`, `elasticsearch`, `splunk`, `http_endpoint`, `opensearch`, `opensearchserverless` and `snowflake`.

[Arn](#arn_csharp) string

The Amazon Resource Name (ARN) specifying the Stream

[DestinationId](#destinationid_csharp) string

[ElasticsearchConfiguration](#elasticsearchconfiguration_csharp) [FirehoseDeliveryStreamElasticsearchConfiguration](#firehosedeliverystreamelasticsearchconfiguration)

Configuration options when `destination` is `elasticsearch`. See `elasticsearch_configuration` block below for details.

[ExtendedS3Configuration](#extendeds3configuration_csharp) [FirehoseDeliveryStreamExtendedS3Configuration](#firehosedeliverystreamextendeds3configuration)

Enhanced configuration options for the s3 destination. See `extended_s3_configuration` block below for details.

[HttpEndpointConfiguration](#httpendpointconfiguration_csharp) [FirehoseDeliveryStreamHttpEndpointConfiguration](#firehosedeliverystreamhttpendpointconfiguration)

Configuration options when `destination` is `http_endpoint`. Requires the user to also specify an `s3_configuration` block. See `http_endpoint_configuration` block below for details.

[IcebergConfiguration](#icebergconfiguration_csharp) [FirehoseDeliveryStreamIcebergConfiguration](#firehosedeliverystreamicebergconfiguration)

Configuration options when `destination` is `iceberg`. See `iceberg_configuration` block below for details.

[KinesisSourceConfiguration](#kinesissourceconfiguration_csharp) [FirehoseDeliveryStreamKinesisSourceConfiguration](#firehosedeliverystreamkinesissourceconfiguration)

The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesis_source_configuration` block below for details.

[MskSourceConfiguration](#msksourceconfiguration_csharp) [FirehoseDeliveryStreamMskSourceConfiguration](#firehosedeliverystreammsksourceconfiguration)

The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `msk_source_configuration` block below for details.

[Name](#name_csharp) string

A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.

[OpensearchConfiguration](#opensearchconfiguration_csharp) [FirehoseDeliveryStreamOpensearchConfiguration](#firehosedeliverystreamopensearchconfiguration)

Configuration options when `destination` is `opensearch`. See `opensearch_configuration` block below for details.

[OpensearchserverlessConfiguration](#opensearchserverlessconfiguration_csharp) [FirehoseDeliveryStreamOpensearchserverlessConfiguration](#firehosedeliverystreamopensearchserverlessconfiguration)

Configuration options when `destination` is `opensearchserverless`. See `opensearchserverless_configuration` block below for details.

[RedshiftConfiguration](#redshiftconfiguration_csharp) [FirehoseDeliveryStreamRedshiftConfiguration](#firehosedeliverystreamredshiftconfiguration)

Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3_configuration` block. See `redshift_configuration` block below for details.

[ServerSideEncryption](#serversideencryption_csharp) [FirehoseDeliveryStreamServerSideEncryption](#firehosedeliverystreamserversideencryption)

Encrypt at rest options. See `server_side_encryption` block below for details.

**NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

[SnowflakeConfiguration](#snowflakeconfiguration_csharp) [FirehoseDeliveryStreamSnowflakeConfiguration](#firehosedeliverystreamsnowflakeconfiguration)

Configuration options when `destination` is `snowflake`. See `snowflake_configuration` block below for details.

[SplunkConfiguration](#splunkconfiguration_csharp) [FirehoseDeliveryStreamSplunkConfiguration](#firehosedeliverystreamsplunkconfiguration)

Configuration options when `destination` is `splunk`. See `splunk_configuration` block below for details.

[Tags](#tags_csharp) Dictionary<string, string>

A map of tags to assign to the resource. If configured with a provider `default_tags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.

[VersionId](#versionid_csharp) string

[Destination](#destination_go) string

This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extended_s3` instead), `extended_s3`, `redshift`, `elasticsearch`, `splunk`, `http_endpoint`, `opensearch`, `opensearchserverless` and `snowflake`.

[Arn](#arn_go) string

The Amazon Resource Name (ARN) specifying the Stream

[DestinationId](#destinationid_go) string

[ElasticsearchConfiguration](#elasticsearchconfiguration_go) [FirehoseDeliveryStreamElasticsearchConfigurationArgs](#firehosedeliverystreamelasticsearchconfiguration)

Configuration options when `destination` is `elasticsearch`. See `elasticsearch_configuration` block below for details.

[ExtendedS3Configuration](#extendeds3configuration_go) [FirehoseDeliveryStreamExtendedS3ConfigurationArgs](#firehosedeliverystreamextendeds3configuration)

Enhanced configuration options for the s3 destination. See `extended_s3_configuration` block below for details.

[HttpEndpointConfiguration](#httpendpointconfiguration_go) [FirehoseDeliveryStreamHttpEndpointConfigurationArgs](#firehosedeliverystreamhttpendpointconfiguration)

Configuration options when `destination` is `http_endpoint`. Requires the user to also specify an `s3_configuration` block. See `http_endpoint_configuration` block below for details.

[IcebergConfiguration](#icebergconfiguration_go) [FirehoseDeliveryStreamIcebergConfigurationArgs](#firehosedeliverystreamicebergconfiguration)

Configuration options when `destination` is `iceberg`. See `iceberg_configuration` block below for details.

[KinesisSourceConfiguration](#kinesissourceconfiguration_go) [FirehoseDeliveryStreamKinesisSourceConfigurationArgs](#firehosedeliverystreamkinesissourceconfiguration)

The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesis_source_configuration` block below for details.

[MskSourceConfiguration](#msksourceconfiguration_go) [FirehoseDeliveryStreamMskSourceConfigurationArgs](#firehosedeliverystreammsksourceconfiguration)

The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `msk_source_configuration` block below for details.

[Name](#name_go) string

A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.

[OpensearchConfiguration](#opensearchconfiguration_go) [FirehoseDeliveryStreamOpensearchConfigurationArgs](#firehosedeliverystreamopensearchconfiguration)

Configuration options when `destination` is `opensearch`. See `opensearch_configuration` block below for details.

[OpensearchserverlessConfiguration](#opensearchserverlessconfiguration_go) [FirehoseDeliveryStreamOpensearchserverlessConfigurationArgs](#firehosedeliverystreamopensearchserverlessconfiguration)

Configuration options when `destination` is `opensearchserverless`. See `opensearchserverless_configuration` block below for details.

[RedshiftConfiguration](#redshiftconfiguration_go) [FirehoseDeliveryStreamRedshiftConfigurationArgs](#firehosedeliverystreamredshiftconfiguration)

Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3_configuration` block. See `redshift_configuration` block below for details.

[ServerSideEncryption](#serversideencryption_go) [FirehoseDeliveryStreamServerSideEncryptionArgs](#firehosedeliverystreamserversideencryption)

Encrypt at rest options. See `server_side_encryption` block below for details.

**NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

[SnowflakeConfiguration](#snowflakeconfiguration_go) [FirehoseDeliveryStreamSnowflakeConfigurationArgs](#firehosedeliverystreamsnowflakeconfiguration)

Configuration options when `destination` is `snowflake`. See `snowflake_configuration` block below for details.

[SplunkConfiguration](#splunkconfiguration_go) [FirehoseDeliveryStreamSplunkConfigurationArgs](#firehosedeliverystreamsplunkconfiguration)

Configuration options when `destination` is `splunk`. See `splunk_configuration` block below for details.

[Tags](#tags_go) map\[string\]string

A map of tags to assign to the resource. If configured with a provider `default_tags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.

[VersionId](#versionid_go) string

[destination](#destination_java) String

This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extended_s3` instead), `extended_s3`, `redshift`, `elasticsearch`, `splunk`, `http_endpoint`, `opensearch`, `opensearchserverless` and `snowflake`.

[arn](#arn_java) String

The Amazon Resource Name (ARN) specifying the Stream

[destinationId](#destinationid_java) String

[elasticsearchConfiguration](#elasticsearchconfiguration_java) [FirehoseDeliveryStreamElasticsearchConfiguration](#firehosedeliverystreamelasticsearchconfiguration)

Configuration options when `destination` is `elasticsearch`. See `elasticsearch_configuration` block below for details.

[extendedS3Configuration](#extendeds3configuration_java) [FirehoseDeliveryStreamExtendedS3Configuration](#firehosedeliverystreamextendeds3configuration)

Enhanced configuration options for the s3 destination. See `extended_s3_configuration` block below for details.

[httpEndpointConfiguration](#httpendpointconfiguration_java) [FirehoseDeliveryStreamHttpEndpointConfiguration](#firehosedeliverystreamhttpendpointconfiguration)

Configuration options when `destination` is `http_endpoint`. Requires the user to also specify an `s3_configuration` block. See `http_endpoint_configuration` block below for details.

[icebergConfiguration](#icebergconfiguration_java) [FirehoseDeliveryStreamIcebergConfiguration](#firehosedeliverystreamicebergconfiguration)

Configuration options when `destination` is `iceberg`. See `iceberg_configuration` block below for details.

[kinesisSourceConfiguration](#kinesissourceconfiguration_java) [FirehoseDeliveryStreamKinesisSourceConfiguration](#firehosedeliverystreamkinesissourceconfiguration)

The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesis_source_configuration` block below for details.

[mskSourceConfiguration](#msksourceconfiguration_java) [FirehoseDeliveryStreamMskSourceConfiguration](#firehosedeliverystreammsksourceconfiguration)

The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `msk_source_configuration` block below for details.

[name](#name_java) String

A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.

[opensearchConfiguration](#opensearchconfiguration_java) [FirehoseDeliveryStreamOpensearchConfiguration](#firehosedeliverystreamopensearchconfiguration)

Configuration options when `destination` is `opensearch`. See `opensearch_configuration` block below for details.

[opensearchserverlessConfiguration](#opensearchserverlessconfiguration_java) [FirehoseDeliveryStreamOpensearchserverlessConfiguration](#firehosedeliverystreamopensearchserverlessconfiguration)

Configuration options when `destination` is `opensearchserverless`. See `opensearchserverless_configuration` block below for details.

[redshiftConfiguration](#redshiftconfiguration_java) [FirehoseDeliveryStreamRedshiftConfiguration](#firehosedeliverystreamredshiftconfiguration)

Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3_configuration` block. See `redshift_configuration` block below for details.

[serverSideEncryption](#serversideencryption_java) [FirehoseDeliveryStreamServerSideEncryption](#firehosedeliverystreamserversideencryption)

Encrypt at rest options. See `server_side_encryption` block below for details.

**NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

[snowflakeConfiguration](#snowflakeconfiguration_java) [FirehoseDeliveryStreamSnowflakeConfiguration](#firehosedeliverystreamsnowflakeconfiguration)

Configuration options when `destination` is `snowflake`. See `snowflake_configuration` block below for details.

[splunkConfiguration](#splunkconfiguration_java) [FirehoseDeliveryStreamSplunkConfiguration](#firehosedeliverystreamsplunkconfiguration)

Configuration options when `destination` is `splunk`. See `splunk_configuration` block below for details.

[tags](#tags_java) Map<String,String>

A map of tags to assign to the resource. If configured with a provider `default_tags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.

[versionId](#versionid_java) String

[destination](#destination_nodejs) string

This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extended_s3` instead), `extended_s3`, `redshift`, `elasticsearch`, `splunk`, `http_endpoint`, `opensearch`, `opensearchserverless` and `snowflake`.

[arn](#arn_nodejs) string

The Amazon Resource Name (ARN) specifying the Stream

[destinationId](#destinationid_nodejs) string

[elasticsearchConfiguration](#elasticsearchconfiguration_nodejs) [FirehoseDeliveryStreamElasticsearchConfiguration](#firehosedeliverystreamelasticsearchconfiguration)

Configuration options when `destination` is `elasticsearch`. See `elasticsearch_configuration` block below for details.

[extendedS3Configuration](#extendeds3configuration_nodejs) [FirehoseDeliveryStreamExtendedS3Configuration](#firehosedeliverystreamextendeds3configuration)

Enhanced configuration options for the s3 destination. See `extended_s3_configuration` block below for details.

[httpEndpointConfiguration](#httpendpointconfiguration_nodejs) [FirehoseDeliveryStreamHttpEndpointConfiguration](#firehosedeliverystreamhttpendpointconfiguration)

Configuration options when `destination` is `http_endpoint`. Requires the user to also specify an `s3_configuration` block. See `http_endpoint_configuration` block below for details.

[icebergConfiguration](#icebergconfiguration_nodejs) [FirehoseDeliveryStreamIcebergConfiguration](#firehosedeliverystreamicebergconfiguration)

Configuration options when `destination` is `iceberg`. See `iceberg_configuration` block below for details.

[kinesisSourceConfiguration](#kinesissourceconfiguration_nodejs) [FirehoseDeliveryStreamKinesisSourceConfiguration](#firehosedeliverystreamkinesissourceconfiguration)

The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesis_source_configuration` block below for details.

[mskSourceConfiguration](#msksourceconfiguration_nodejs) [FirehoseDeliveryStreamMskSourceConfiguration](#firehosedeliverystreammsksourceconfiguration)

The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `msk_source_configuration` block below for details.

[name](#name_nodejs) string

A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.

[opensearchConfiguration](#opensearchconfiguration_nodejs) [FirehoseDeliveryStreamOpensearchConfiguration](#firehosedeliverystreamopensearchconfiguration)

Configuration options when `destination` is `opensearch`. See `opensearch_configuration` block below for details.

[opensearchserverlessConfiguration](#opensearchserverlessconfiguration_nodejs) [FirehoseDeliveryStreamOpensearchserverlessConfiguration](#firehosedeliverystreamopensearchserverlessconfiguration)

Configuration options when `destination` is `opensearchserverless`. See `opensearchserverless_configuration` block below for details.

[redshiftConfiguration](#redshiftconfiguration_nodejs) [FirehoseDeliveryStreamRedshiftConfiguration](#firehosedeliverystreamredshiftconfiguration)

Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3_configuration` block. See `redshift_configuration` block below for details.

[serverSideEncryption](#serversideencryption_nodejs) [FirehoseDeliveryStreamServerSideEncryption](#firehosedeliverystreamserversideencryption)

Encrypt at rest options. See `server_side_encryption` block below for details.

**NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

[snowflakeConfiguration](#snowflakeconfiguration_nodejs) [FirehoseDeliveryStreamSnowflakeConfiguration](#firehosedeliverystreamsnowflakeconfiguration)

Configuration options when `destination` is `snowflake`. See `snowflake_configuration` block below for details.

[splunkConfiguration](#splunkconfiguration_nodejs) [FirehoseDeliveryStreamSplunkConfiguration](#firehosedeliverystreamsplunkconfiguration)

Configuration options when `destination` is `splunk`. See `splunk_configuration` block below for details.

[tags](#tags_nodejs) {\[key: string\]: string}

A map of tags to assign to the resource. If configured with a provider `default_tags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.

[versionId](#versionid_nodejs) string

[destination](#destination_python) str

This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extended_s3` instead), `extended_s3`, `redshift`, `elasticsearch`, `splunk`, `http_endpoint`, `opensearch`, `opensearchserverless` and `snowflake`.

[arn](#arn_python) str

The Amazon Resource Name (ARN) specifying the Stream

[destination\_id](#destination_id_python) str

[elasticsearch\_configuration](#elasticsearch_configuration_python) [FirehoseDeliveryStreamElasticsearchConfigurationArgs](#firehosedeliverystreamelasticsearchconfiguration)

Configuration options when `destination` is `elasticsearch`. See `elasticsearch_configuration` block below for details.

[extended\_s3\_configuration](#extended_s3_configuration_python) [FirehoseDeliveryStreamExtendedS3ConfigurationArgs](#firehosedeliverystreamextendeds3configuration)

Enhanced configuration options for the s3 destination. See `extended_s3_configuration` block below for details.

[http\_endpoint\_configuration](#http_endpoint_configuration_python) [FirehoseDeliveryStreamHttpEndpointConfigurationArgs](#firehosedeliverystreamhttpendpointconfiguration)

Configuration options when `destination` is `http_endpoint`. Requires the user to also specify an `s3_configuration` block. See `http_endpoint_configuration` block below for details.

[iceberg\_configuration](#iceberg_configuration_python) [FirehoseDeliveryStreamIcebergConfigurationArgs](#firehosedeliverystreamicebergconfiguration)

Configuration options when `destination` is `iceberg`. See `iceberg_configuration` block below for details.

[kinesis\_source\_configuration](#kinesis_source_configuration_python) [FirehoseDeliveryStreamKinesisSourceConfigurationArgs](#firehosedeliverystreamkinesissourceconfiguration)

The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesis_source_configuration` block below for details.

[msk\_source\_configuration](#msk_source_configuration_python) [FirehoseDeliveryStreamMskSourceConfigurationArgs](#firehosedeliverystreammsksourceconfiguration)

The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `msk_source_configuration` block below for details.

[name](#name_python) str

A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.

[opensearch\_configuration](#opensearch_configuration_python) [FirehoseDeliveryStreamOpensearchConfigurationArgs](#firehosedeliverystreamopensearchconfiguration)

Configuration options when `destination` is `opensearch`. See `opensearch_configuration` block below for details.

[opensearchserverless\_configuration](#opensearchserverless_configuration_python) [FirehoseDeliveryStreamOpensearchserverlessConfigurationArgs](#firehosedeliverystreamopensearchserverlessconfiguration)

Configuration options when `destination` is `opensearchserverless`. See `opensearchserverless_configuration` block below for details.

[redshift\_configuration](#redshift_configuration_python) [FirehoseDeliveryStreamRedshiftConfigurationArgs](#firehosedeliverystreamredshiftconfiguration)

Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3_configuration` block. See `redshift_configuration` block below for details.

[server\_side\_encryption](#server_side_encryption_python) [FirehoseDeliveryStreamServerSideEncryptionArgs](#firehosedeliverystreamserversideencryption)

Encrypt at rest options. See `server_side_encryption` block below for details.

**NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

[snowflake\_configuration](#snowflake_configuration_python) [FirehoseDeliveryStreamSnowflakeConfigurationArgs](#firehosedeliverystreamsnowflakeconfiguration)

Configuration options when `destination` is `snowflake`. See `snowflake_configuration` block below for details.

[splunk\_configuration](#splunk_configuration_python) [FirehoseDeliveryStreamSplunkConfigurationArgs](#firehosedeliverystreamsplunkconfiguration)

Configuration options when `destination` is `splunk`. See `splunk_configuration` block below for details.

[tags](#tags_python) Mapping\[str, str\]

A map of tags to assign to the resource. If configured with a provider `default_tags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.

[version\_id](#version_id_python) str

[destination](#destination_yaml) String

This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extended_s3` instead), `extended_s3`, `redshift`, `elasticsearch`, `splunk`, `http_endpoint`, `opensearch`, `opensearchserverless` and `snowflake`.

[arn](#arn_yaml) String

The Amazon Resource Name (ARN) specifying the Stream

[destinationId](#destinationid_yaml) String

[elasticsearchConfiguration](#elasticsearchconfiguration_yaml) [Property Map](#firehosedeliverystreamelasticsearchconfiguration)

Configuration options when `destination` is `elasticsearch`. See `elasticsearch_configuration` block below for details.

[extendedS3Configuration](#extendeds3configuration_yaml) [Property Map](#firehosedeliverystreamextendeds3configuration)

Enhanced configuration options for the s3 destination. See `extended_s3_configuration` block below for details.

[httpEndpointConfiguration](#httpendpointconfiguration_yaml) [Property Map](#firehosedeliverystreamhttpendpointconfiguration)

Configuration options when `destination` is `http_endpoint`. Requires the user to also specify an `s3_configuration` block. See `http_endpoint_configuration` block below for details.

[icebergConfiguration](#icebergconfiguration_yaml) [Property Map](#firehosedeliverystreamicebergconfiguration)

Configuration options when `destination` is `iceberg`. See `iceberg_configuration` block below for details.

[kinesisSourceConfiguration](#kinesissourceconfiguration_yaml) [Property Map](#firehosedeliverystreamkinesissourceconfiguration)

The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesis_source_configuration` block below for details.

[mskSourceConfiguration](#msksourceconfiguration_yaml) [Property Map](#firehosedeliverystreammsksourceconfiguration)

The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `msk_source_configuration` block below for details.

[name](#name_yaml) String

A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.

[opensearchConfiguration](#opensearchconfiguration_yaml) [Property Map](#firehosedeliverystreamopensearchconfiguration)

Configuration options when `destination` is `opensearch`. See `opensearch_configuration` block below for details.

[opensearchserverlessConfiguration](#opensearchserverlessconfiguration_yaml) [Property Map](#firehosedeliverystreamopensearchserverlessconfiguration)

Configuration options when `destination` is `opensearchserverless`. See `opensearchserverless_configuration` block below for details.

[redshiftConfiguration](#redshiftconfiguration_yaml) [Property Map](#firehosedeliverystreamredshiftconfiguration)

Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3_configuration` block. See `redshift_configuration` block below for details.

[serverSideEncryption](#serversideencryption_yaml) [Property Map](#firehosedeliverystreamserversideencryption)

Encrypt at rest options. See `server_side_encryption` block below for details.

**NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.

[snowflakeConfiguration](#snowflakeconfiguration_yaml) [Property Map](#firehosedeliverystreamsnowflakeconfiguration)

Configuration options when `destination` is `snowflake`. See `snowflake_configuration` block below for details.

[splunkConfiguration](#splunkconfiguration_yaml) [Property Map](#firehosedeliverystreamsplunkconfiguration)

Configuration options when `destination` is `splunk`. See `splunk_configuration` block below for details.

[tags](#tags_yaml) Map<String>

A map of tags to assign to the resource. If configured with a provider `default_tags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.

[versionId](#versionid_yaml) String

### Outputs

All [input](#inputs) properties are implicitly available as output properties. Additionally, the FirehoseDeliveryStream resource produces the following output properties:

[Id](#id_csharp) string

The provider-assigned unique ID for this managed resource.

[TagsAll](#tagsall_csharp) Dictionary<string, string>

A map of tags assigned to the resource, including those inherited from the provider `default_tags` configuration block.

Deprecated: Please use `tags` instead.

[Id](#id_go) string

The provider-assigned unique ID for this managed resource.

[TagsAll](#tagsall_go) map\[string\]string

A map of tags assigned to the resource, including those inherited from the provider `default_tags` configuration block.

Deprecated: Please use `tags` instead.

[id](#id_java) String

The provider-assigned unique ID for this managed resource.

[tagsAll](#tagsall_java) Map<String,String>

A map of tags assigned to the resource, including those inherited from the provider `default_tags` configuration block.

Deprecated: Please use `tags` instead.

[id](#id_nodejs) string

The provider-assigned unique ID for this managed resource.

[tagsAll](#tagsall_nodejs) {\[key: string\]: string}

A map of tags assigned to the resource, including those inherited from the provider `default_tags` configuration block.

Deprecated: Please use `tags` instead.

[id](#id_python) str

The provider-assigned unique ID for this managed resource.

[tags\_all](#tags_all_python) Mapping\[str, str\]

A map of tags assigned to the resource, including those inherited from the provider `default_tags` configuration block.

Deprecated: Please use `tags` instead.

[id](#id_yaml) String

The provider-assigned unique ID for this managed resource.

[tagsAll](#tagsall_yaml) Map<String>

A map of tags assigned to the resource, including those inherited from the provider `default_tags` configuration block.

Deprecated: Please use `tags` instead.

---

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

---

# Glue Catalog Docs

```
const catalogTableResource = new aws.glue.CatalogTable("catalogTableResource", {
    databaseName: "string",
    parameters: {
        string: "string",
    },
    description: "string",
    name: "string",
    openTableFormatInput: {
        icebergInput: {
            metadataOperation: "string",
            version: "string",
        },
    },
    owner: "string",
    catalogId: "string",
    partitionIndices: [{
        indexName: "string",
        keys: ["string"],
        indexStatus: "string",
    }],
    partitionKeys: [{
        name: "string",
        comment: "string",
        type: "string",
    }],
    retention: 0,
    storageDescriptor: {
        additionalLocations: ["string"],
        bucketColumns: ["string"],
        columns: [{
            name: "string",
            comment: "string",
            parameters: {
                string: "string",
            },
            type: "string",
        }],
        compressed: false,
        inputFormat: "string",
        location: "string",
        numberOfBuckets: 0,
        outputFormat: "string",
        parameters: {
            string: "string",
        },
        schemaReference: {
            schemaVersionNumber: 0,
            schemaId: {
                registryName: "string",
                schemaArn: "string",
                schemaName: "string",
            },
            schemaVersionId: "string",
        },
        serDeInfo: {
            name: "string",
            parameters: {
                string: "string",
            },
            serializationLibrary: "string",
        },
        skewedInfo: {
            skewedColumnNames: ["string"],
            skewedColumnValueLocationMaps: {
                string: "string",
            },
            skewedColumnValues: ["string"],
        },
        sortColumns: [{
            column: "string",
            sortOrder: 0,
        }],
        storedAsSubDirectories: false,
    },
    tableType: "string",
    targetTable: {
        catalogId: "string",
        databaseName: "string",
        name: "string",
        region: "string",
    },
    viewExpandedText: "string",
    viewOriginalText: "string",
});
```

Inputs
The CatalogTable resource accepts the following input properties:

databaseName 
This property is required.
Changes to this property will trigger replacement.
string
Name of the metadata database where the table metadata resides. For Hive compatibility, this must be all lowercase.

The follow arguments are optional:

catalogId Changes to this property will trigger replacement.
string
ID of the Glue Catalog and database to create the table in. If omitted, this defaults to the AWS Account ID plus the database name.
description
string
Description of the table.
name Changes to this property will trigger replacement.
string
Name of the table. For Hive compatibility, this must be entirely lowercase.
openTableFormatInput
CatalogTableOpenTableFormatInput
Configuration block for open table formats. See open_table_format_input below.
owner
string
Owner of the table.
parameters
{[key: string]: string}
Properties associated with this table, as a list of key-value pairs.
partitionIndices Changes to this property will trigger replacement.
CatalogTablePartitionIndex[]
Configuration block for a maximum of 3 partition indexes. See partition_index below.
partitionKeys
CatalogTablePartitionKey[]
Configuration block of columns by which the table is partitioned. Only primitive types are supported as partition keys. See partition_keys below.
retention
number
Retention time for this table.
storageDescriptor
CatalogTableStorageDescriptor
Configuration block for information about the physical storage of this table. For more information, refer to the Glue Developer Guide. See storage_descriptor below.
tableType
string
Type of this table (EXTERNAL_TABLE, VIRTUAL_VIEW, etc.). While optional, some Athena DDL queries such as ALTER TABLE and SHOW CREATE TABLE will fail if this argument is empty.
targetTable Changes to this property will trigger replacement.
CatalogTableTargetTable
Configuration block of a target table for resource linking. See target_table below.
viewExpandedText
string
If the table is a view, the expanded text of the view; otherwise null.
viewOriginalText
string
If the table is a view, the original text of the view; otherwise null.
Outputs
All input properties are implicitly available as output properties. Additionally, the CatalogTable resource produces the following output properties:

arn
string
The ARN of the Glue Table.
id
string
The provider-assigned unique ID for this managed resource.

Supporting Types
CatalogTableOpenTableFormatInput
icebergInput This property is required.
CatalogTableOpenTableFormatInputIcebergInput
Configuration block for iceberg table config. See iceberg_input below.
CatalogTableOpenTableFormatInputIcebergInput
metadataOperation This property is required.
string
A required metadata operation. Can only be set to CREATE.
version
string
The table version for the Iceberg table. Defaults to 2.
CatalogTablePartitionIndex
indexName This property is required.
string
Name of the partition index.
keys This property is required.
string[]
Keys for the partition index.
indexStatus
string
CatalogTablePartitionKey
name This property is required.
string
Name of the Partition Key.
comment
string
Free-form text comment.
type
string
Datatype of data in the Partition Key.
CatalogTableStorageDescriptor
additionalLocations
string[]
List of locations that point to the path where a Delta table is located.
bucketColumns
string[]
List of reducer grouping columns, clustering columns, and bucketing columns in the table.
columns
CatalogTableStorageDescriptorColumn[]
Configuration block for columns in the table. See columns below.
compressed
boolean
Whether the data in the table is compressed.
inputFormat
string
Input format: SequenceFileInputFormat (binary), or TextInputFormat, or a custom format.
location
string
Physical location of the table. By default this takes the form of the warehouse location, followed by the database location in the warehouse, followed by the table name.
numberOfBuckets
number
Must be specified if the table contains any dimension columns.
outputFormat
string
Output format: SequenceFileOutputFormat (binary), or IgnoreKeyTextOutputFormat, or a custom format.
parameters
{[key: string]: string}
User-supplied properties in key-value form.
schemaReference
CatalogTableStorageDescriptorSchemaReference
Object that references a schema stored in the AWS Glue Schema Registry. When creating a table, you can pass an empty list of columns for the schema, and instead use a schema reference. See Schema Reference below.
serDeInfo
CatalogTableStorageDescriptorSerDeInfo
Configuration block for serialization and deserialization ("SerDe") information. See ser_de_info below.
skewedInfo
CatalogTableStorageDescriptorSkewedInfo
Configuration block with information about values that appear very frequently in a column (skewed values). See skewed_info below.
sortColumns
CatalogTableStorageDescriptorSortColumn[]
Configuration block for the sort order of each bucket in the table. See sort_columns below.
storedAsSubDirectories
boolean
Whether the table data is stored in subdirectories.
CatalogTableStorageDescriptorColumn
name This property is required.
string
Name of the Column.
comment
string
Free-form text comment.
parameters
{[key: string]: string}
Key-value pairs defining properties associated with the column.
type
string
Datatype of data in the Column.
CatalogTableStorageDescriptorSchemaReference
schemaVersionNumber This property is required.
number
Version number of the schema.
schemaId
CatalogTableStorageDescriptorSchemaReferenceSchemaId
Configuration block that contains schema identity fields. Either this or the schema_version_id has to be provided. See schema_id below.
schemaVersionId
string
Unique ID assigned to a version of the schema. Either this or the schema_id has to be provided.
CatalogTableStorageDescriptorSchemaReferenceSchemaId
registryName
string
Name of the schema registry that contains the schema. Must be provided when schema_name is specified and conflicts with schema_arn.
schemaArn
string
ARN of the schema. One of schema_arn or schema_name has to be provided.
schemaName
string
Name of the schema. One of schema_arn or schema_name has to be provided.
CatalogTableStorageDescriptorSerDeInfo
name
string
Name of the SerDe.
parameters
{[key: string]: string}
Map of initialization parameters for the SerDe, in key-value form.
serializationLibrary
string
Usually the class that implements the SerDe. An example is org.apache.hadoop.hive.serde2.columnar.ColumnarSerDe.
CatalogTableStorageDescriptorSkewedInfo
skewedColumnNames
string[]
List of names of columns that contain skewed values.
skewedColumnValueLocationMaps
{[key: string]: string}
List of values that appear so frequently as to be considered skewed.
skewedColumnValues
string[]
Map of skewed values to the columns that contain them.
CatalogTableStorageDescriptorSortColumn
column This property is required.
string
Name of the column.
sortOrder This property is required.
number
Whether the column is sorted in ascending (1) or descending order (0).
CatalogTableTargetTable
catalogId This property is required.
string
ID of the Data Catalog in which the table resides.
databaseName This property is required.
string
Name of the catalog database that contains the target table.
name This property is required.
string
Name of the target table.
region
string
Region of the target table.