import json
import pulumi
import pulumi_aws as aws
import pulumi_aws_native as aws_native # Using aws-native for S3 Express
import pulumi_asset as asset
from datetime import datetime

# --- Configuration ---
# S3 Express One Zone buckets are ZONAL. Choose an AZ.
# Ensure your Pulumi AWS provider is configured for the target region.
aws_region = aws.get_region().name
account_id = aws.get_caller_identity().account_id
availability_zone_id = "use1-az4" # IMPORTANT: Replace with a valid AZ ID in your chosen region
# You can dynamically get AZs, but for simplicity, hardcoding one here.
# azs = aws.get_availability_zones(state="available")
# availability_zone_id = azs.zone_ids[0]

# S3 Express bucket names have a specific format: --<az-id>--x-s3
bucket_base_name = "my-s3-table-bucket"
s3_express_bucket_name = f"{bucket_base_name}--{availability_zone_id}--x-s3"

database_name = "s3_tables_db"
table_name = "web_events_s3_table"
firehose_stream_name = "s3-tables-delivery-stream"

# --- 1. S3 Express One Zone Directory Bucket (for S3 Table data) ---
# NOTE: DirectoryBuckets incur costs as soon as created.
s3_express_directory_bucket = aws_native.s3express.DirectoryBucket("s3ExpressDirectoryBucket",
    # Location requires the AZ ID
    location=aws_native.s3express.DirectoryBucketLocationArgs(
        name=availability_zone_id,
        type="AvailabilityZone" # Explicitly stating type
    ),
    bucket_name=s3_express_bucket_name,
    data_redundancy="SingleAvailabilityZone",
    # Tags can be added if needed
    # tags=[...]
)

# Construct the S3 Express ARN and Base URL (path) for the table
# ARN format: arn:aws:s3express:<region>:<account_id>:bucket/<bucket_name>--<az-id>--x-s3
s3_express_bucket_arn = pulumi.Output.concat("arn:aws:s3express:", aws_region, ":", account_id, ":bucket/", s3_express_directory_bucket.bucket_name)
# Base URL format: s3express://<bucket_name>--<az-id>--x-s3/
s3_express_table_location = pulumi.Output.concat("s3express://", s3_express_directory_bucket.bucket_name, "/", table_name, "/")
firehose_error_output_prefix = pulumi.Output.concat("s3express://", s3_express_directory_bucket.bucket_name, "/firehose-errors/")


# --- 2. Glue Catalog Database ---
glue_database = aws.glue.CatalogDatabase("s3TablesGlueDatabase",
    name=database_name)

# --- 3. Lambda for Date Partition Extraction (Likely Still Needed) ---
# Firehose dynamic partitioning requires partition keys to be present in the
# record *before* the partitioning step. If 'date' isn't in the source,
# we need to add it.
# (Lambda code and role definition are identical to the previous example - omitted here for brevity)
# Assume 'partition_lambda' and 'lambda_role' are defined as before.

# --- Placeholder for Lambda ---
partition_lambda_arn = "arn:aws:lambda:..." # Replace with actual ARN from your lambda definition if used
partition_lambda_role_arn = "arn:aws:iam:..." # Replace with actual ARN from your lambda role definition if used
# --- End Placeholder ---


# --- 4. Glue Catalog Table (Defining the S3 Table Structure) ---
# This defines the logical table using the Iceberg format, pointing to the S3 Express bucket.
glue_table = aws.glue.CatalogTable("s3GlueTableForExpress",
    database_name=glue_database.name,
    name=table_name,
    table_type="ICEBERG", # Essential for S3 Tables integration
    # Define schema AFTER potential Lambda transformation
    storage_descriptor=aws.glue.CatalogTableStorageDescriptorArgs(
        location=s3_express_table_location, # Use the s3express:// path
        # Input/Output format and SerDe are less critical for Glue reading Iceberg
        # but needed placeholders for table creation via API sometimes.
        input_format="org.apache.hadoop.mapred.TextInputFormat", # Placeholder
        output_format="org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat", # Placeholder
        serde_info=aws.glue.CatalogTableStorageDescriptorSerdeInfoArgs( # Placeholder
             name="IcebergSerDe",
             serialization_library="org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe"
        ),
        # Schema MUST match data structure Firehose delivers (post-Lambda)
        columns=[
            aws.glue.CatalogTableStorageDescriptorColumnArgs(name="site_id", type="string"),
            aws.glue.CatalogTableStorageDescriptorColumnArgs(name="timestamp", type="timestamp"),
            aws.glue.CatalogTableStorageDescriptorColumnArgs(name="event_data", type="string"),
            # Add other fields...
            aws.glue.CatalogTableStorageDescriptorColumnArgs(name="date", type="date"), # Added by Lambda
        ],
    ),
    # Define partition keys
    partition_keys=[
        aws.glue.CatalogTableStorageDescriptorColumnArgs(name="site_id", type="string"),
        aws.glue.CatalogTableStorageDescriptorColumnArgs(name="date", type="date"),
    ],
    # Crucial parameters for Iceberg / S3 Tables integration
    parameters={
        "table_type": "ICEBERG", # Explicitly declare Iceberg
        "format": "parquet", # Underlying data file format
        "write.parquet.compression-codec": "snappy",
        # Add S3 Table specific parameters if documented/required by AWS
        # e.g., "s3_table_bucket_arn": s3_express_bucket_arn, # Hypothetical parameter
        # Note: Automatic compaction is managed by S3 Tables service itself,
        # so Glue/Lake Formation compaction settings might not be needed here.
    })

# --- 5. IAM Role for Kinesis Firehose ---
# **CRITICAL**: This role MUST have permissions to write to S3 Express.
firehose_role = aws.iam.Role("firehoseS3ExpressRole",
    assume_role_policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Action": "sts:AssumeRole",
            "Effect": "Allow",
            "Principal": {"Service": "firehose.amazonaws.com"},
        }],
    }))

# Define the policy for Firehose permissions
firehose_policy_document = pulumi.Output.all(
    s3_express_bucket_arn,
    s3_express_directory_bucket.bucket_name, # Needed for resource path construction
    partition_lambda_arn, # Use the actual Lambda ARN if defined
    glue_database.catalog_id,
    glue_database.name,
    glue_table.name
).apply(lambda args: json.dumps({
    "Version": "2012-10-17",
    "Statement": [
        { # S3 Express Permissions (Potentially requires these specific actions)
            "Effect": "Allow",
            "Action": [
                "s3express:CreateSession", # Required for interacting with S3 Express buckets
                "s3express:PutObject"      # Required to write data
                # May also need AbortMultipartUpload equivalent if Firehose uses multipart
            ],
            "Resource": [
                args[0],           # Bucket ARN
                f"{args[0]}/*"     # Objects within the bucket path
                # Potentially needs separate resource for session creation? Check docs.
            ]
        },
        { # Glue Permissions for Iceberg metadata
            "Effect": "Allow",
            "Action": [
                "glue:GetDatabase",
                "glue:GetTable",
                "glue:UpdateTable" # Essential for Iceberg metadata updates by Firehose
            ],
            "Resource": [
                f"arn:aws:glue:{aws_region}:{args[3]}:catalog",
                f"arn:aws:glue:{aws_region}:{args[3]}:database/{args[4]}",
                f"arn:aws:glue:{aws_region}:{args[3]}:table/{args[4]}/{args[5]}"
            ]
        },
        # --- TEMPORARILY COMMENTED OUT - ADD IF USING LAMBDA ---
        # { # Lambda Invocation Permission (if using transformation Lambda)
        #     "Effect": "Allow",
        #     "Action": ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"],
        #     "Resource": args[2] # Lambda function ARN
        # },
        # --- END TEMPORARY COMMENT ---
        { # CloudWatch Logs Permissions
            "Effect": "Allow",
            "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
            "Resource": [f"arn:aws:logs:{aws_region}:{account_id}:log-group:/aws/kinesisfirehose/{firehose_stream_name}:*"]
        }
    ]
}))

firehose_policy = aws.iam.Policy("firehoseS3ExpressPolicy",
    policy=firehose_policy_document)

aws.iam.RolePolicyAttachment("firehoseS3ExpressPolicyAttachment",
    role=firehose_role.name,
    policy_arn=firehose_policy.arn)

# --- 6. Kinesis Firehose Delivery Stream ---
# Assuming 'extended_s3' destination can target S3 Express ARNs.
firehose_stream = aws.kinesis.FirehoseDeliveryStream("s3TablesFirehoseStream",
    name=firehose_stream_name,
    destination="extended_s3",

    extended_s3_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationArgs(
        role_arn=firehose_role.arn,
        bucket_arn=s3_express_bucket_arn, # Use the S3 Express bucket ARN
        # Prefix MUST align with the Glue Table location path segment
        prefix=pulumi.Output.concat(table_name, "/"),
        # Error output prefix - ensure it uses a valid structure for S3 Express
        # error_output_prefix=pulumi.Output.concat("firehose-errors/", table_name, "/"), # Adjust if needed

        buffering_interval=60, # S3 Express might benefit from faster flushing
        buffering_size=5,      # Smaller buffer sizes might be suitable

        compression_format="UNCOMPRESSED", # Let Parquet handle compression via SerDe

        cloudwatch_logging_options=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationCloudwatchLoggingOptionsArgs(
            enabled=True,
            log_group_name=f"/aws/kinesisfirehose/{firehose_stream_name}",
            log_stream_name="S3ExpressDelivery"
        ),

        # --- Data Transformation using Lambda (Uncomment if needed) ---
        # processing_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationArgs(
        #     enabled=True,
        #     processors=[aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationProcessorArgs(
        #         type="Lambda",
        #         parameters=[aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationProcessingConfigurationProcessorParameterArgs(
        #             parameter_name="LambdaArn",
        #             parameter_value=partition_lambda_arn, # Use actual Lambda ARN
        #         )],
        #     )],
        # ),
        # --- End Data Transformation ---

        # Data Format Conversion (JSON -> Parquet for Iceberg)
        data_format_conversion_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationArgs(
            enabled=True,
            input_format_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationInputFormatConfigurationArgs(
                deserializer=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationInputFormatConfigurationDeserializerArgs(
                    open_x_json_ser_de=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationInputFormatConfigurationDeserializerOpenXJsonSerDeArgs()
                )
            ),
            output_format_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationOutputFormatConfigurationArgs(
                serializer=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationOutputFormatConfigurationSerializerArgs(
                    parquet_ser_de=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationOutputFormatConfigurationSerializerParquetSerDeArgs(
                         compression="SNAPPY", # Match Glue table parameter
                    )
                )
            ),
            # Link conversion schema to the Glue table
            schema_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDataFormatConversionConfigurationSchemaConfigurationArgs(
                role_arn=firehose_role.arn, # Role needs Glue access
                database_name=glue_database.name,
                table_name=glue_table.name,
                region=aws_region,
                # catalog_id=account_id # Usually defaults to current account
            )
        ),

        # Dynamic Partitioning based on data fields (site_id, date)
        dynamic_partitioning_configuration=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDynamicPartitioningConfigurationArgs(
            enabled=True,
            retry_options=aws.kinesis.FirehoseDeliveryStreamExtendedS3ConfigurationDynamicPartitioningConfigurationRetryOptionsArgs(
                duration_in_seconds=60
            )
        ),
    ))


# --- Outputs ---
pulumi.export("s3_express_bucket_name", s3_express_directory_bucket.bucket_name)
pulumi.export("s3_express_bucket_arn", s3_express_bucket_arn)
pulumi.export("s3_table_location", s3_express_table_location)
pulumi.export("glue_database_name", glue_database.name)
pulumi.export("glue_table_name", glue_table.name)
pulumi.export("firehose_delivery_stream_name", firehose_stream.name)
pulumi.export("firehose_delivery_stream_arn", firehose_stream.arn)