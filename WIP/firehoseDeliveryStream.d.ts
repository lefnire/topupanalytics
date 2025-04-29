export interface FirehoseDeliveryStreamArgs {
    /**
     * The Amazon Resource Name (ARN) specifying the Stream
     */
    arn?: pulumi.Input<string>;
    /**
     * This is the destination to where the data is delivered. The only options are `s3` (Deprecated, use `extendedS3` instead), `extendedS3`, `redshift`, `elasticsearch`, `splunk`, `httpEndpoint`, `opensearch`, `opensearchserverless` and `snowflake`.
     */
    destination: pulumi.Input<string>;
    destinationId?: pulumi.Input<string>;
    /**
     * Configuration options when `destination` is `elasticsearch`. See `elasticsearchConfiguration` block below for details.
     */
    elasticsearchConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamElasticsearchConfiguration>;
    /**
     * Enhanced configuration options for the s3 destination. See `extendedS3Configuration` block below for details.
     */
    extendedS3Configuration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3Configuration>;
    /**
     * Configuration options when `destination` is `httpEndpoint`. Requires the user to also specify an `s3Configuration` block.  See `httpEndpointConfiguration` block below for details.
     */
    httpEndpointConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamHttpEndpointConfiguration>;
    /**
     * Configuration options when `destination` is `iceberg`. See `icebergConfiguration` block below for details.
     */
    icebergConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfiguration>;
    /**
     * The stream and role Amazon Resource Names (ARNs) for a Kinesis data stream used as the source for a delivery stream. See `kinesisSourceConfiguration` block below for details.
     */
    kinesisSourceConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamKinesisSourceConfiguration>;
    /**
     * The configuration for the Amazon MSK cluster to be used as the source for a delivery stream. See `mskSourceConfiguration` block below for details.
     */
    mskSourceConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamMskSourceConfiguration>;
    /**
     * A name to identify the stream. This is unique to the AWS account and region the Stream is created in. When using for WAF logging, name must be prefixed with `aws-waf-logs-`. See [AWS Documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-policies.html#waf-policies-logging-config) for more details.
     */
    name?: pulumi.Input<string>;
    /**
     * Configuration options when `destination` is `opensearch`. See `opensearchConfiguration` block below for details.
     */
    opensearchConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamOpensearchConfiguration>;
    /**
     * Configuration options when `destination` is `opensearchserverless`. See `opensearchserverlessConfiguration` block below for details.
     */
    opensearchserverlessConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamOpensearchserverlessConfiguration>;
    /**
     * Configuration options when `destination` is `redshift`. Requires the user to also specify an `s3Configuration` block. See `redshiftConfiguration` block below for details.
     */
    redshiftConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamRedshiftConfiguration>;
    /**
     * Encrypt at rest options. See `serverSideEncryption` block below for details.
     *
     * **NOTE:** Server-side encryption should not be enabled when a kinesis stream is configured as the source of the firehose delivery stream.
     */
    serverSideEncryption?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamServerSideEncryption>;
    /**
     * Configuration options when `destination` is `snowflake`. See `snowflakeConfiguration` block below for details.
     */
    snowflakeConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamSnowflakeConfiguration>;
    /**
     * Configuration options when `destination` is `splunk`. See `splunkConfiguration` block below for details.
     */
    splunkConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamSplunkConfiguration>;
    /**
     * A map of tags to assign to the resource. If configured with a provider `defaultTags` configuration block present, tags with matching keys will overwrite those defined at the provider-level.
     */
    tags?: pulumi.Input<{
        [key: string]: pulumi.Input<string>;
    }>;
    versionId?: pulumi.Input<string>;
}
interface FirehoseDeliveryStreamExtendedS3Configuration {
        /**
         * The ARN of the S3 bucket
         */
        bucketArn: pulumi.Input<string>;
        bufferingInterval?: pulumi.Input<number>;
        bufferingSize?: pulumi.Input<number>;
        cloudwatchLoggingOptions?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationCloudwatchLoggingOptions>;
        /**
         * The compression format. If no value is specified, the default is `UNCOMPRESSED`. Other supported values are `GZIP`, `ZIP`, `Snappy`, & `HADOOP_SNAPPY`.
         */
        compressionFormat?: pulumi.Input<string>;
        /**
         * The time zone you prefer. Valid values are `UTC` or a non-3-letter IANA time zones (for example, `America/Los_Angeles`). Default value is `UTC`.
         */
        customTimeZone?: pulumi.Input<string>;
        /**
         * Nested argument for the serializer, deserializer, and schema for converting data from the JSON format to the Parquet or ORC format before writing it to Amazon S3. See `dataFormatConversionConfiguration` block below for details.
         */
        dataFormatConversionConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfiguration>;
        /**
         * The configuration for dynamic partitioning. Required when using [dynamic partitioning](https://docs.aws.amazon.com/firehose/latest/dev/dynamic-partitioning.html). See `dynamicPartitioningConfiguration` block below for details.
         */
        dynamicPartitioningConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDynamicPartitioningConfiguration>;
        /**
         * Prefix added to failed records before writing them to S3. Not currently supported for `redshift` destination. This prefix appears immediately following the bucket name. For information about how to specify this prefix, see [Custom Prefixes for Amazon S3 Objects](https://docs.aws.amazon.com/firehose/latest/dev/s3-prefixes.html).
         */
        errorOutputPrefix?: pulumi.Input<string>;
        /**
         * The file extension to override the default file extension (for example, `.json`).
         */
        fileExtension?: pulumi.Input<string>;
        /**
         * Specifies the KMS key ARN the stream will use to encrypt data. If not set, no encryption will
         * be used.
         */
        kmsKeyArn?: pulumi.Input<string>;
        /**
         * The "YYYY/MM/DD/HH" time format prefix is automatically used for delivered S3 files. You can specify an extra prefix to be added in front of the time format prefix. Note that if the prefix ends with a slash, it appears as a folder in the S3 bucket
         */
        prefix?: pulumi.Input<string>;
        /**
         * The data processing configuration.  See `processingConfiguration` block below for details.
         */
        processingConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfiguration>;
        roleArn: pulumi.Input<string>;
        /**
         * The configuration for backup in Amazon S3. Required if `s3BackupMode` is `Enabled`. Supports the same fields as `s3Configuration` object.
         */
        s3BackupConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationS3BackupConfiguration>;
        /**
         * The Amazon S3 backup mode.  Valid values are `Disabled` and `Enabled`.  Default value is `Disabled`.
         */
        s3BackupMode?: pulumi.Input<string>;
    }
    interface FirehoseDeliveryStreamExtendedS3ConfigurationDynamicPartitioningConfiguration {
        /**
         * Enables or disables dynamic partitioning. Defaults to `false`.
         */
        enabled?: pulumi.Input<boolean>;
        /**
         * Total amount of seconds Firehose spends on retries. Valid values between 0 and 7200. Default is 300.
         *
         * > **NOTE:** You can enable dynamic partitioning only when you create a new delivery stream. Once you enable dynamic partitioning on a delivery stream, it cannot be disabled on this delivery stream. Therefore, the provider will recreate the resource whenever dynamic partitioning is enabled or disabled.
         */
        retryDuration?: pulumi.Input<number>;
    }
    interface FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfiguration {
        /**
         * Enables or disables data processing.
         */
        enabled?: pulumi.Input<boolean>;
        /**
         * Specifies the data processors as multiple blocks. See `processors` block below for details.
         */
        processors?: pulumi.Input<pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationProcessor>[]>;
    }
    interface FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationProcessor {
        /**
         * Specifies the processor parameters as multiple blocks. See `parameters` block below for details.
         */
        parameters?: pulumi.Input<pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationProcessorParameter>[]>;
        /**
         * The type of processor. Valid Values: `RecordDeAggregation`, `Lambda`, `MetadataExtraction`, `AppendDelimiterToRecord`, `Decompression`, `CloudWatchLogProcessing`. Validation is done against [AWS SDK constants](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/service/firehose/types#ProcessorType); so values not explicitly listed may also work.
         */
        type: pulumi.Input<string>;
    }
    interface FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationProcessorParameter {
        /**
         * Parameter name. Valid Values: `LambdaArn`, `NumberOfRetries`, `MetadataExtractionQuery`, `JsonParsingEngine`, `RoleArn`, `BufferSizeInMBs`, `BufferIntervalInSeconds`, `SubRecordType`, `Delimiter`, `CompressionFormat`, `DataMessageExtraction`. Validation is done against [AWS SDK constants](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/service/firehose/types#ProcessorParameterName); so values not explicitly listed may also work.
         */
        parameterName: pulumi.Input<string>;
        /**
         * Parameter value. Must be between 1 and 512 length (inclusive). When providing a Lambda ARN, you should specify the resource version as well.
         *
         * > **NOTE:** Parameters with default values, including `NumberOfRetries`(default: 3), `RoleArn`(default: firehose role ARN), `BufferSizeInMBs`(default: 1), and `BufferIntervalInSeconds`(default: 60), are not stored in Pulumi state. To prevent perpetual differences, it is therefore recommended to only include parameters with non-default values.
         */
        parameterValue: pulumi.Input<string>;
    }
    interface FirehoseDeliveryStreamIcebergConfiguration {
        /**
         * Buffer incoming data for the specified period of time, in seconds between 0 and 900, before delivering it to the destination. The default value is 300.
         */
        bufferingInterval?: pulumi.Input<number>;
        /**
         * Buffer incoming data to the specified size, in MBs between 1 and 128, before delivering it to the destination. The default value is 5.
         */
        bufferingSize?: pulumi.Input<number>;
        /**
         * Glue catalog ARN identifier of the destination Apache Iceberg Tables. You must specify the ARN in the format `arn:aws:glue:region:account-id:catalog`
         */
        catalogArn: pulumi.Input<string>;
        /**
         * The CloudWatch Logging Options for the delivery stream. See `cloudwatchLoggingOptions` block below for details.
         */
        cloudwatchLoggingOptions?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfigurationCloudwatchLoggingOptions>;
        /**
         * Destination table configurations which Firehose uses to deliver data to Apache Iceberg Tables. Firehose will write data with insert if table specific configuration is not provided. See `destinationTableConfiguration` block below for details.
         */
        destinationTableConfigurations?: pulumi.Input<pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfigurationDestinationTableConfiguration>[]>;
        /**
         * The data processing configuration.  See `processingConfiguration` block below for details.
         */
        processingConfiguration?: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfigurationProcessingConfiguration>;
        /**
         * The period of time, in seconds between 0 to 7200, during which Firehose retries to deliver data to the specified destination.
         */
        retryDuration?: pulumi.Input<number>;
        /**
         * The ARN of the IAM role to be assumed by Firehose for calling Apache Iceberg Tables.
         */
        roleArn: pulumi.Input<string>;
        s3BackupMode?: pulumi.Input<string>;
        /**
         * The S3 Configuration. See `s3Configuration` block below for details.
         */
        s3Configuration: pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfigurationS3Configuration>;
    }
    interface FirehoseDeliveryStreamIcebergConfigurationDestinationTableConfiguration {
        /**
         * The name of the Apache Iceberg database.
         */
        databaseName: pulumi.Input<string>;
        /**
         * The table specific S3 error output prefix. All the errors that occurred while delivering to this table will be prefixed with this value in S3 destination.
         */
        s3ErrorOutputPrefix?: pulumi.Input<string>;
        /**
         * The name of the Apache Iceberg Table.
         */
        tableName: pulumi.Input<string>;
        /**
         * A list of unique keys for a given Apache Iceberg table. Firehose will use these for running Create, Update, or Delete operations on the given Iceberg table.
         */
        uniqueKeys?: pulumi.Input<pulumi.Input<string>[]>;
    }
    interface FirehoseDeliveryStreamIcebergConfigurationProcessingConfiguration {
        /**
         * Enables or disables data processing.
         */
        enabled?: pulumi.Input<boolean>;
        /**
         * Specifies the data processors as multiple blocks. See `processors` block below for details.
         */
        processors?: pulumi.Input<pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfigurationProcessingConfigurationProcessor>[]>;
    }
    interface FirehoseDeliveryStreamIcebergConfigurationProcessingConfigurationProcessor {
        /**
         * Specifies the processor parameters as multiple blocks. See `parameters` block below for details.
         */
        parameters?: pulumi.Input<pulumi.Input<inputs.kinesis.FirehoseDeliveryStreamIcebergConfigurationProcessingConfigurationProcessorParameter>[]>;
        /**
         * The type of processor. Valid Values: `RecordDeAggregation`, `Lambda`, `MetadataExtraction`, `AppendDelimiterToRecord`, `Decompression`, `CloudWatchLogProcessing`. Validation is done against [AWS SDK constants](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/service/firehose/types#ProcessorType); so values not explicitly listed may also work.
         */
        type: pulumi.Input<string>;
    }
    interface FirehoseDeliveryStreamIcebergConfigurationProcessingConfigurationProcessorParameter {
        /**
         * Parameter name. Valid Values: `LambdaArn`, `NumberOfRetries`, `MetadataExtractionQuery`, `JsonParsingEngine`, `RoleArn`, `BufferSizeInMBs`, `BufferIntervalInSeconds`, `SubRecordType`, `Delimiter`, `CompressionFormat`, `DataMessageExtraction`. Validation is done against [AWS SDK constants](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/service/firehose/types#ProcessorParameterName); so values not explicitly listed may also work.
         */
        parameterName: pulumi.Input<string>;
        /**
         * Parameter value. Must be between 1 and 512 length (inclusive). When providing a Lambda ARN, you should specify the resource version as well.
         *
         * > **NOTE:** Parameters with default values, including `NumberOfRetries`(default: 3), `RoleArn`(default: firehose role ARN), `BufferSizeInMBs`(default: 1), and `BufferIntervalInSeconds`(default: 60), are not stored in Pulumi state. To prevent perpetual differences, it is therefore recommended to only include parameters with non-default values.
         */
        parameterValue: pulumi.Input<string>;
    }