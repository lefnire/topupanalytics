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