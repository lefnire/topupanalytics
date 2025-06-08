Working with Amazon S3 Tables and table buckets


===================================================

Amazon S3 Tables provide S3 storage that’s optimized for analytics workloads, with features designed to continuously improve query performance and reduce storage costs for tables. S3 Tables are purpose-built for storing tabular data, such as daily purchase transactions, streaming sensor data, or ad impressions. Tabular data represents data in columns and rows, like in a database table.

The data in S3 Tables is stored in a new bucket type: a _table bucket_, which stores tables as subresources. Table buckets support storing tables in the Apache Iceberg format. Using standard SQL statements, you can query your tables with query engines that support Iceberg, such as Amazon Athena, Amazon Redshift, and Apache Spark.


Features of S3 Tables


-----------------------

**Purpose-built storage for tables**

S3 table buckets are specifically designed for tables. Table buckets provide higher transactions per second (TPS) and better query throughput compared to self-managed tables in S3 general purpose buckets. Table buckets deliver the same durability, availability, and scalability as other Amazon S3 bucket types.

**Built-in support for Apache Iceberg**

Tables in your table buckets are stored in [Apache Iceberg](https://aws.amazon.com/what-is/apache-iceberg/) format. You can query these tables using standard SQL in query engines that support Iceberg. Iceberg has a variety of features to optimize query performance, including schema evolution and partition evolution.

With Iceberg, you can change how your data is organized so that it can evolve over time without requiring you to rewrite your queries or rebuild your data structures. Iceberg is designed to help ensure data consistency and reliability through its support for transactions. To help you correct issues or perform time travel queries, you can track how data changes over time and roll back to historical versions.

**Automated table optimization**

To optimize your tables for querying, S3 continuously performs automatic maintenance operations, such as compaction, snapshot management, and unreferenced file removal. These operations increase table performance by compacting smaller objects into fewer, larger files. Maintenance operations also reduce your storage costs by cleaning up unused objects. This automated maintenance streamlines the operation of data lakes at scale by reducing the need for manual table maintenance. For each table and table bucket, you can customize maintenance configurations.

**Access management and security**

You can manage access for both table buckets and individual tables with AWS Identity and Access Management (IAM) and [Service Control Policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html) in AWS Organizations. S3 Tables uses a different service namespace than Amazon S3: the _s3tables_ namespace. Therefore, you can design policies specifically for the S3 Tables service and its resources. You can design policies to grant access to individual tables, all tables within a table namespace, or entire table buckets. All Amazon S3 Block Public Access settings are always enabled for table buckets and cannot be disabled.

**Integration with AWS analytics services**

You can automatically integrate your Amazon S3 table buckets with Amazon SageMaker Lakehouse through the S3 console. This integration allows AWS analytics services to automatically discover and access your table data through the AWS Glue Data Catalog. After the integration, you can work with your tables using analytics services such as Amazon Athena, Amazon Redshift, QuickSight, and more. For more information about how the integration works, see [Using Amazon S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html).

Related services


------------------

You can use the following AWS services with S3 Tables to support your specific analytics applications.

*   [**Amazon Athena**](https://docs.aws.amazon.com/athena/latest/ug/what-is.html) – Athena is an interactive query service that you can use to analyze data directly in Amazon S3 by using standard SQL. You can also use Athena to interactively run data analytics by using Apache Spark without having to plan for, configure, or manage resources. When you run Apache Spark applications on Athena, you submit Spark code for processing and receive the results directly.
    
*   [**AWS Glue**](https://docs.aws.amazon.com/glue/latest/dg/what-is-glue.html) – AWS Glue is a serverless data-integration service that allows you to discover, prepare, move, and integrate data from multiple sources. You can use AWS Glue for analytics, machine learning (ML), and application development. AWS Glue also includes additional productivity and data-operations tooling for authoring, running jobs, and implementing business workflows.
    
*   [**Amazon EMR**](https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-what-is-emr.html) – Amazon EMR is a managed cluster platform that simplifies running big data frameworks, such as Apache Hadoop and Apache Spark, on AWS to process and analyze vast amounts of data.
    
*   [**Amazon Redshift**](https://docs.aws.amazon.com/redshift/latest/mgmt/welcome.html) – Amazon Redshift is a petabyte-scale data warehouse service in the cloud. You can use Amazon Redshift Serverless to access and analyze data without all of the configurations of a provisioned data warehouse. Resources are automatically provisioned and data warehouse capacity is intelligently scaled to deliver fast performance for even the most demanding and unpredictable workloads. You don't incur charges when the data warehouse is idle, so you only pay for what you use. You can load data and start querying right away in the Amazon Redshift query editor v2 or in your favorite business intelligence (BI) tool.
    
*   [**QuickSight**](https://docs.aws.amazon.com/quicksight/latest/user/welcome.html) – QuickSight is a business analytics service to build visualizations, perform ad hoc analysis, and quickly get business insights from your data. QuickSight seamlessly discovers AWS data sources and delivers fast and responsive query performance by using the QuickSight Super-fast, Parallel, In-Memory, Calculation Engine (SPICE).
    
*   [**AWS Lake Formation**](https://docs.aws.amazon.com/lake-formation/latest/dg/what-is-lake-formation.html.html) – Lake Formation is a managed service that streamlines the process to set up, secure, and manage your data lakes. Lake Formation helps you discover your data sources and then catalog, cleanse, and transform the data. With Lake Formation, you can manage fine-grained access control for your data lake data on Amazon S3 and its metadata in AWS Glue Data Catalog.

---

Tutorial: Getting started with S3 Tables


============================================


In this tutorial, you create a table bucket and integrate table buckets in your Region with AWS analytics services. Next, you will use the AWS CLI to create your first namespace and table in your table bucket. Then, you use AWS Lake Formation to grant permission on your table, so you can begin querying your table with Athena.

###### Tip

If you're migrating tabular data from general purpose buckets to table buckets, the AWS Solutions Library has a guided solution to assist you. This solution automates moving Apache Iceberg and Apache Hive tables that are registered in AWS Glue Data Catalog and stored in general purpose buckets to table buckets by using AWS Step Functions and Amazon EMR with Apache Spark. For more information, see [Guidance for Migrating Tabular Data from Amazon S3 to S3 Tables](https://aws.amazon.com/solutions/guidance/migrating-tabular-data-from-amazon-s3-to-s3-tables/) in the AWS Solutions Library.

###### Topics

*   [Step 1: Create a table bucket and integrate it with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-getting-started.html#s1-tables-tutorial-create-bucket)
    
*   [Step 2: Create a table namespace and a table](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-getting-started.html#s2-tables-tutorial-EMR-cluster)
    
*   [(Optional) Step 3: Grant Lake Formation permissions on your table](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-getting-started.html#s3-tables-tutorial-create-table)
    
*   [Step 4: Query data with SQL in Athena](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-getting-started.html#s4-query-tables)
    

Step 1: Create a table bucket and integrate it with AWS analytics services


----------------------------------------------------------------------------

In this step, you use the Amazon S3 console to create your first table bucket. For other ways to create a table bucket, see [Creating a table bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-buckets-create.html).

###### Note

By default, the Amazon S3 console automatically integrates your table buckets with Amazon SageMaker Lakehouse, which allows AWS analytics services to automatically discover and access your S3 Tables data. If you create your first table bucket programmatically by using the AWS Command Line Interface (AWS CLI), AWS SDKs, or REST API, you must manually complete the AWS analytics services integration. For more information, see [Using Amazon S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html).

1.  Sign in to the AWS Management Console and open the Amazon S3 console at [https://console.aws.amazon.com/s3/](https://console.aws.amazon.com/s3/).
    
2.  In the navigation bar on the top of the page, choose the name of the currently displayed AWS Region. Next, choose the Region in which you want to create the table bucket.
    
3.  In the left navigation pane, choose **Table buckets**.
    
4.  Choose **Create table bucket**.
    
5.  Under **General configuration**, enter a name for your table bucket.
    
    The table bucket name must:
    
    *   Be unique within for your AWS account in the current Region.
        
    *   Be between 3 and 63 characters long.
        
    *   Consist only of lowercase letters, numbers, and hyphens (`-`).
        
    *   Begin and end with a letter or number.
        
    
    After you create the table bucket, you can't change its name. The AWS account that creates the table bucket owns it. For more information about naming table buckets, see [Table bucket naming rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-buckets-naming.html#table-buckets-naming-rules).
    
6.  In the **Integration with AWS analytics services** section, make sure that the **Enable integration** checkbox is selected.
    
    If **Enable integration** is selected when you create your first table bucket by using the console, Amazon S3 attempts to integrate your table bucket with AWS analytics services. This integration allows you to use AWS analytics services to access all tables in the current Region. For more information, see [Using Amazon S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html).
    
7.  Choose **Create bucket**.
    

Step 2: Create a table namespace and a table


----------------------------------------------

For this step, you create a namespace in your table bucket, and then create a new table under that namespace. You can create a table namespace and a table by using either the console or the AWS CLI.

###### Important

When creating tables, make sure that you use all lowercase letters in your table names and table definitions. For example, make sure that your column names are all lowercase. If your table name or table definition contains capital letters, the table isn't supported by AWS Lake Formation or the AWS Glue Data Catalog. In this case, your table won't be visible to AWS analytics services such as Amazon Athena, even if your table buckets are integrated with AWS analytics services.

If your table definition contains capital letters, you receive the following error message when running a `SELECT` query in Athena: **`"GENERIC_INTERNAL_ERROR: Get table request failed: com.amazonaws.services.glue.model.ValidationException: Unsupported Federation Resource - Invalid table or column names."`**

Using the S3 console and Amazon Athena
--------------------------------------

Using the AWS CLI
-----------------

To use the following AWS CLI example commands to create a namespace in your table bucket, and then create a new table with a schema under that namespace, replace the `` `user input placeholder` `` values with your own.

###### Prerequisites

*   Attach the [`AmazonS3TablesFullAccess`](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonS3TablesFullAccess.html) policy to your IAM identity.
    
*   Install AWS CLI version 2.23.10 or higher. For more information, see [Installing or updating the latest version of the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) in the _AWS Command Line Interface User Guide_.
    

1.  Create a new namespace in your table bucket by running the following command:
    
    ``aws s3tables create-namespace \
    --table-bucket-arn arn:aws:s3tables:`us-east-1`:`111122223333`:bucket/`amzn-s3-demo-table-bucket` \
    --namespace `my_namespace` `` 
    
    1.  Confirm that your namespace was created successfully by running the following command:
        
        ``aws s3tables list-namespaces \
        --table-bucket-arn arn:aws:s3tables:`us-east-1`:`111122223333`:bucket/`amzn-s3-demo-table-bucket` ``
        
2.  Create a new table with a table schema by running the following command:
    
    ``aws s3tables create-table --cli-input-json file://`mytabledefinition.json` ``
    
    For the `mytabledefinition.json` file, use the following example table definition:
    
    ``{
        "tableBucketARN": "arn:aws:s3tables:`us-east-1`:`111122223333`:bucket/`amzn-s3-demo-table-bucket`",
        "namespace": "`my_namespace`",
        "name": "`my_table`",
        "format": "ICEBERG",
        "metadata": {
            "iceberg": {
                "schema": {
                    "fields": [
                         `{"name": "id", "type": "int","required": true},
                         {"name": "name", "type": "string"},
                         {"name": "value", "type": "int"}`
                    ]
                }
            }
        }
    }``
    

(Optional) Step 3: Grant Lake Formation permissions on your table


-------------------------------------------------------------------

For this step, you grant Lake Formation permissions on your new table to other IAM principals. These permissions allow principals other than you to access table bucket resources by using Athena and other AWS analytics services. For more information, see [Granting permission on a table or database](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#grant-lf-table). If you're the only user who will access your tables, you can skip this step.

1.  Open the AWS Lake Formation console at [https://console.aws.amazon.com/lakeformation/](https://console.aws.amazon.com/lakeformation/), and sign in as a data lake administrator. For more information about how to create a data lake administrator, see [Create a data lake administrator](https://docs.aws.amazon.com/lake-formation/latest/dg/initial-lf-config.html#create-data-lake-admin).
    
2.  In the navigation pane, choose **Data permissions** and then choose **Grant**.
    
3.  On the **Grant Permissions** page, under **Principals**, choose **IAM users and roles** and choose the IAM user or role that you want to allow to run queries on your table.
    
4.  Under **LF-Tags or catalog resources**, choose **Named Data Catalog resources**.
    
5.  Do one of the following, depending on whether you want to grant access to all of the tables in your account or whether you want to grant access to only the resources within the table bucket that you created:
    
    *   For **Catalogs**, choose the account-level catalog that you created when you integrated your table bucket. For example, `` `111122223333`:s3tablescatalog``.
        
    *   For **Catalogs**, choose the subcatalog for your table bucket. For example, `` `111122223333`:s3tablescatalog/`amzn-s3-demo-table-bucket` ``.
        
6.  (Optional) If you chose the subcatalog for your table bucket, do one or both of the following:
    
    *   For **Databases**, choose the table bucket namespace that you created.
        
    *   For **Tables**, choose the table that you created in your table bucket, or choose **All tables**.
        
7.  Depending on whether you chose a catalog or subcatalog and depending on whether you then chose a database or a table, you can set permissions at the catalog, database, or table level. For more information about Lake Formation permissions, see [Managing Lake Formation permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/managing-permissions.html) in the _AWS Lake Formation Developer Guide_.
    
    Do one of the following:
    
    *   For **Catalog permissions**, choose **Super** to grant the other principal all permissions on your catalog, or choose more fine-grained permissions, such as **Describe**.
        
    *   For **Database permissions**, you can't choose **Super** to grant the other principal all permissions on your database. Instead, choose more fine-grained permissions, such as **Describe**.
        
    *   For **Table permissions**, choose **Super** to grant the other principal all permissions on your table, or choose more fine-grained permissions, such as **Select** or **Describe**.
        
        ###### Note
        
        When you grant Lake Formation permissions on a Data Catalog resource to an external account or directly to an IAM principal in another account, Lake Formation uses the AWS Resource Access Manager (AWS RAM) service to share the resource. If the grantee account is in the same organization as the grantor account, the shared resource is available immediately to the grantee. If the grantee account is not in the same organization, AWS RAM sends an invitation to the grantee account to accept or reject the resource grant. Then, to make the shared resource available, the data lake administrator in the grantee account must use the AWS RAM console or AWS CLI to accept the invitation. For more information about cross-account data sharing, see [Cross-account data sharing in Lake Formation](https://docs.aws.amazon.com/lake-formation/latest/dg/cross-account-permissions.html) in the _AWS Lake Formation Developer Guide_.
        
8.  Choose **Grant**.
    

Step 4: Query data with SQL in Athena


---------------------------------------

You can query your table with SQL in Athena. Athena supports Data Definition Language (DDL), Data Manipulation Language (DML), and Data Query Language (DQL) queries for S3 Tables.

You can access the Athena query either from the Amazon S3 console or through the Amazon Athena console.

Using the S3 console and Amazon Athena
--------------------------------------

Using the Amazon Athena console
-------------------------------

###### To query a table

1.  Open the Athena console at [https://console.aws.amazon.com/athena/](https://console.aws.amazon.com/athena/home).
    
2.  Query your table. The following is a sample query that you can modify. Make sure to replace the `` `user input placeholders` `` with your own information.
    
    ``SELECT * FROM "s3tablescatalog/`amzn-s3-demo-table-bucket`"."`my_namespace`"."`my_table`" LIMIT 10``
    
3.  To run the query, choose **Run**.

---

Table buckets


=================

Amazon S3 table buckets are an S3 bucket type that you can use to create and store tables as S3 resources. Table buckets are used to store tabular data and metadata as objects for use in analytics workloads. S3 performs maintenance in your table buckets automatically to help reduce your table storage costs. For more information, see [Amazon S3 table bucket maintenance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-table-buckets-maintenance.html).

To interact with the tables stored inside your table buckets, you can integrate your table buckets with analytics applications that support [Apache Iceberg](https://iceberg.apache.org/docs/latest/). Table buckets integrate with AWS analytics services through the AWS Glue Data Catalog. For more information, see [Using Amazon S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html). You can also interact with your tables using open-source query engines using the Amazon S3 Tables Catalog for Apache Iceberg. For more information, see [Accessing tables using the Amazon S3 Tables Iceberg REST endpoint](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-open-source.html).

Each table bucket has a unique Amazon Resource Name (ARN) and resource policy attached to it. Table bucket ARNs follow this format:

``arn:aws:s3tables:`Region`:`OwnerAccountID`:bucket/`bucket-name` ``

All table buckets and tables are private and can't be made public. These resources can only be accessed by users who are explicitly granted access. To grant access, you can use IAM resource-based policies for table buckets and tables, and IAM identity-based policies for users and roles.

By default, you can create up to 10 table buckets per AWS Region in an AWS account. To request a quota increase for table buckets or tables, contact [Support](https://console.aws.amazon.com/support/home#/case/create?issueType=service-limit-increase).

There are several types of Amazon S3 buckets. Before creating a bucket, make sure that you choose the bucket type that best fits your application and performance requirements. For more information about the various bucket types and the appropriate use cases for each, see [Buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#BasicsBucket).

---

Amazon S3 table bucket, table, and namespace naming rules


=============================================================

When you create a table bucket, you choose a bucket name and AWS Region, the name must be unique for your account in the chosen Region. After you create a table bucket, you can't change the bucket name or Region. Table bucket names must follow specific naming rules. For more information about naming rules for table buckets and the tables and namespaces within them, see the following topic.

###### Topics

*   [Table bucket naming rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-buckets-naming.html#table-buckets-naming-rules)
    
*   [Naming rules for tables and namespaces](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-buckets-naming.html#naming-rules-table)
    

Table bucket naming rules


---------------------------

When you create Amazon S3 table buckets, you specify a table bucket name. Like other bucket types, table buckets can't be renamed. Unlike other bucket types, table buckets aren't in a global namespace, so each bucket name in your account needs to be unique only within your current AWS Region.

For general purpose bucket naming rules, see [General purpose bucket naming rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html). For directory bucket naming rules, see [Directory bucket naming rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-naming-rules.html).

The following naming rules apply for table buckets.

*   Bucket names must be between 3 and 63 characters long.
    
*   Bucket names can consist only of lowercase letters, numbers, and hyphens (`-`).
    
*   Bucket names must begin and end with a letter or number.
    
*   Bucket names must not contain any underscores (`_`) or periods (`.`).
    
*   Bucket names must not start with any of the following reserved prefixes:
    
    *   `xn--`
        
    *   `sthree-`
        
    *   `amzn-s3-demo-`
        
    
*   Bucket names must not end with any of the following reserved suffixes:
    
    *   `-s3alias`
        
    *   `--ol-s3`
        
    *   `--x-s3`
        
    *   `--table-s3`
        
    

Naming rules for tables and namespaces


----------------------------------------

The following naming rules apply to tables and namespaces within table buckets:

*   Names must be between 1 and 225 characters long.
    
*   Names can consist only of lowercase letters, numbers, and underscores (`_`). Underscores aren't allowed at the start or end of namespace names.
    
*   Names must begin and end with a letter or number.
    
*   Names must not contain hyphens (`-`) or periods (`.`).
    
*   A table name must be unique within a namespace.
    
*   A namespace must be unique within a table bucket.
    
*   Namespace names must not start with the reserved prefix `aws`. For example, you can't use `aws_s3_metadata` as a namespace. `aws_s3_metadata` is a reserved namespace for metadata tables. For more information, see [Accelerating data discovery with S3 Metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-overview.html).

---

Table namespaces
When you create tables within your Amazon S3 table bucket, you organize them into logical groupings called namespaces. Unlike S3 tables and table buckets, namespaces aren't resources. Namespaces are constructs that help you organize and manage your tables in a scalable manner. For example, all the tables belonging to the human resources department in a company could be grouped under a common namespace value of hr.

To control access to specific namespaces, you can use table bucket resource policies. For more information, see Resource-based policies for S3 Tables.

The following rules apply to table namespaces:

Each namespace must be unique within a table bucket.

You can create up to 10,000 namespaces per table bucket.

Each table name must be unique within a namespace.

Each table can have only one level of namespaces. Namespaces can't be nested.

Each table belongs to a single namespace.

You can move your tables between namespaces.

---

Tables in S3 table buckets


==============================

An S3 table represents a structured dataset consisting of underlying table data and related metadata. This data is stored inside a table bucket as a subresource. All tables in a table bucket are stored in the [Apache Iceberg](https://iceberg.apache.org/docs/latest/) table format. Amazon S3 manages maintenance of your tables through automatic file compaction and snapshot management. For more information, see [S3 Tables maintenance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-maintenance.html).

To make tables in your account accessible by AWS analytics services, you integrate your Amazon S3 table buckets with Amazon SageMaker Lakehouse. This integration allows AWS analytics services such as Amazon Athena and Amazon Redshift to automatically discover and access your table data.

When you create a table, Amazon S3 automatically generates a warehouse location for the table. This is a unique S3 location that stores objects associated with the table. The following example shows the format of a warehouse location:

`s3://63a8e430-6e0b-46f5-k833abtwr6s8tmtsycedn8s4yc3xhuse1b--table-s3`

Within your table bucket, you can organize tables into logical groupings called namespaces. For more information, see [Table namespaces](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-namespace.html).

You can rename tables, but each table has its own unique Amazon Resource Name (ARN) and unique table ID. Each table also has a resource policy attached to it. You can use this policy to manage access to the table.

Table ARNs use the following format:

``arn:aws:s3tables:`region`:`owner-account-id`:bucket/`bucket-name`/table/`table-id` ``

By default, you can create up to 10,000 tables in a table bucket. To request a quota increase for table buckets or tables, contact [Support](https://console.aws.amazon.com/support/home#/case/create?issueType=service-limit-increase).

Amazon S3 supports the following types of tables in table buckets:

**Customer tables**

Customer tables are tables that you can read and write to. You can retrieve data from these tables using integrated query engines. You can insert, update, or delete data within them by using S3 API operations or integrated query engines.

**AWS tables**

AWS tables are read-only tables that are generated by an AWS service on your behalf. These tables are managed by Amazon S3 and can't be modified by any IAM principal outside of Amazon S3 itself. You can retrieve information from these tables, but you can't modify the data in them. AWS tables include S3 Metadata tables, which contain metadata that's captured from the objects within an S3 general purpose bucket. For more information, see [Accelerating data discovery with S3 Metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-overview.html).

---

Accessing table data


========================


There are multiple ways to access tables in Amazon S3 table buckets, you can integrate tables with AWS analytics services using Amazon SageMaker Lakehouse, or access tables directly using the Amazon S3 Tables Iceberg REST endpoint or the Amazon S3 Tables Catalog for Apache Iceberg. The access method you use will depend on your catalog setup, governance model, and access control needs. The following is an overview of these access methods.

**Amazon SageMaker Lakehouse integration**

This is the recommended access method for working with tables in S3 table buckets. The integration gives you unified table management, centralized governance, and fine-grained access control across multiple AWS analytics services.

**Direct access**

Use this method if you need to work with AWS Partner Network (APN) catalog implementations, custom catalog implementations, or if you only need to perform basic read/write operations on tables within a single table bucket.

###### Note

To access tables the IAM identity you use needs access to your table resources and S3 Tables actions. For more information, see [Access management for S3 Tables](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-setting-up.html).

Accessing tables through the Amazon SageMaker Lakehouse integration


---------------------------------------------------------------------

You can integrate S3 table buckets with Amazon SageMaker Lakehouse to access tables from AWS analytics services, such as Amazon Athena, Amazon Redshift, and QuickSight. Amazon SageMaker Lakehouse unifies your data across Amazon S3 data lakes and Amazon Redshift data warehouses, so you can build analytics, machine learning (ML), and generative AI applications on a single copy of data. The integration populates the AWS Glue Data Catalog with your table resources, and federates access to these resources with AWS Lake Formation. For more information on integrating, see [Using Amazon S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html).

The integration enables fine-grained access control through AWS Lake Formation to provide additional security. Lake Formation uses a combination of its own permissions model and the IAM permissions model to control access to table resources and underlying data. This means that a request to access your table must pass permission checks by both IAM and Lake Formation. For more information, see [Lake Formation permissions overview](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-overview.html) in the _AWS Lake Formation Developer Guide_.

The following AWS analytics services can access tables through this integration:

*   [Amazon Athena](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-athena.html)
    
*   [Amazon Redshift](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-redshift.html)
    
*   [Amazon EMR](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-emr.html)
    
*   [QuickSight](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-quicksight.html)
    
*   [Amazon Data Firehose](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html)
    

### Accessing tables using the AWS Glue Iceberg REST endpoint

Once your S3 table buckets are integrated with Amazon SageMaker Lakehouse, you can also use the AWS Glue Iceberg REST endpoint to connect to S3 tables from third-party query engines that support Iceberg. For more information, see [Accessing Amazon S3 tables using the AWS Glue Iceberg REST endpoint](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-glue-endpoint.html).

We recommend using the AWS Glue Iceberg REST endpoint when you want to access tables from Spark, PyIceberg, or other Iceberg-compatible clients.

The following clients can access tables directly through the AWS Glue Iceberg REST endpoint:

*   Any Iceberg client, including Spark, PyIceberg, and more.
    

Accessing tables directly


---------------------------

You can access tables directly from open source query engines through methods that bridge S3 Tables management operations to your Apache Iceberg analytics applications. There are two direct access methods: the Amazon S3 Tables Iceberg REST endpoint or the Amazon S3 Tables Catalog for Apache Iceberg. The REST endpoint is recommended.

We recommend direct access if you access tables in self-managed catalog implementations, or only need to perform basic read/write operations on tables in a single table bucket. For other access scenarios, we recommend the Amazon SageMaker Lakehouse integration.

Direct access to tables is managed through either IAM identity-based policies or resource-based policies attached to tables and table buckets. You do not need to manage Lake Formation permissions for tables when you access them directly.

### Accessing tables through the Amazon S3 Tables Iceberg REST endpoint

You can use the Amazon S3 Tables Iceberg REST endpoint to access your tables directly from any Iceberg REST compatible clients through HTTP endpoints, for more information, see [Accessing tables using the Amazon S3 Tables Iceberg REST endpoint](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-open-source.html).

The following AWS analytics services and query engines can access tables directly using the Amazon S3 Tables Iceberg REST endpoint:

###### Supported query engines

*   Any Iceberg client, including Spark, PyIceberg, and more.
    
*   [Amazon EMR](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-emr.html)
    
*   [AWS Glue ETL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-glue.html)
    

### Accessing tables directly through the Amazon S3 Tables Catalog for Apache Iceberg

You can also access tables directly from query engines like Apache Spark by using the S3 Tables client catalog, for more information, see [Accessing Amazon S3 tables with the Amazon S3 Tables Catalog for Apache Iceberg](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-client-catalog.html). However, S3 recommends using the Amazon S3 Tables Iceberg REST endpoint for direct access because it supports more applications, without requiring language or engine-specific code.

The following query engines can access tables directly using the client catalog:

*   [Apache Spark](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-client-catalog.html#s3-tables-integrating-open-source-spark)

---

Using Amazon S3 Tables with AWS analytics services


======================================================


To make tables in your account accessible by AWS analytics services, you integrate your Amazon S3 table buckets with Amazon SageMaker Lakehouse. This integration allows AWS analytics services to automatically discover and access your table data. You can use this integration to work with your tables in these services:

*   [Amazon Athena](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-athena.html)
    
*   [Amazon Redshift](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-redshift.html)
    
*   [Amazon EMR](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-emr.html)
    
*   [QuickSight](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-quicksight.html)
    
*   [Amazon Data Firehose](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html)
    

###### Note

This integration uses the AWS Glue and AWS Lake Formation services and might incur AWS Glue request and storage costs. For more information, see [AWS Glue Pricing.](https://aws.amazon.com/glue/pricing/)

Additional pricing applies for running queries on your S3 tables. For more information, see pricing information for the query engine that you're using.

How the integration works


---------------------------

When you create a table bucket in the console, Amazon S3 initiates the following actions to integrate table buckets in the Region that you have selected with AWS analytics services:

1.  Creates a new AWS Identity and Access Management (IAM) [service role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-service.html) that gives Lake Formation access to all your table buckets.
    
2.  Using the service role, Lake Formation registers table buckets in the current Region. This allows Lake Formation to manage access, permissions, and governance for all current and future table buckets in that Region.
    
3.  Adds the `s3tablescatalog` catalog to the AWS Glue Data Catalog in the current Region. Adding the `s3tablescatalog` catalog allows all your table buckets, namespaces, and tables to be populated in the Data Catalog.
    

###### Note

These actions are automated through the Amazon S3 console. If you perform this integration programmatically, you must manually take all of these actions.

You integrate your table buckets once per AWS Region. After the integration is completed, all current and future table buckets, namespaces, and tables are added to the AWS Glue Data Catalog in that Region.

The following illustration shows how the `s3tablescatalog` catalog automatically populates table buckets, namespaces, and tables in the current Region as corresponding objects in the Data Catalog. Table buckets are populated as subcatalogs. Namespaces within a table bucket are populated as databases within their respective subcatalogs. Tables are populated as tables in their respective databases.

![The ways that table resources are represented in AWS Glue Data Catalog.](https://docs.aws.amazon.com/images/AmazonS3/latest/userguide/images/S3Tables-glue-catalog.png)

###### How permissions work

We recommend integrating your table buckets with AWS analytics services so that you can work with your table data across services that use the AWS Glue Data Catalog as a metadata store. The integration enables fine-grained access control through AWS Lake Formation. This security approach means that, in addition to AWS Identity and Access Management (IAM) permissions, you must grant your IAM principal Lake Formation permissions on your tables before you can work with them.

There are two main types of permissions in AWS Lake Formation:

*   Metadata access permissions control the ability to create, read, update, and delete metadata databases and tables in the Data Catalog.
    
*   Underlying data access permissions control the ability to read and write data to the underlying Amazon S3 locations that the Data Catalog resources point to.
    

Lake Formation uses a combination of its own permissions model and the IAM permissions model to control access to Data Catalog resources and underlying data:

*   For a request to access Data Catalog resources or underlying data to succeed, the request must pass permission checks by both IAM and Lake Formation.
    
*   IAM permissions control access to the Lake Formation and AWS Glue APIs and resources, whereas Lake Formation permissions control access to the Data Catalog resources, Amazon S3 locations, and the underlying data.
    

Lake Formation permissions apply only in the Region in which they were granted, and a principal must be authorized by a data lake administrator or another principal with the necessary permissions in order to be granted Lake Formation permissions.

For more information, see [Overview of Lake Formation permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-overview.html) in the _AWS Lake Formation Developer Guide_.

Make sure that you follow the steps in [Prerequisites for integration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#table-integration-prerequisites) and [Integrating table buckets with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#table-integration-procedures) so that you have the appropriate permissions to access the AWS Glue Data Catalog and your table resources, and to work with AWS analytics services.

###### Important

If you aren't the user who performed the table buckets integration with AWS analytics services for your account, you must be granted the necessary Lake Formation permissions on the table. For more information, see [Granting permission on a table or database](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#grant-lf-table).

Prerequisites for integration


-------------------------------

The following prerequisites are required to integrate table buckets with AWS analytics services:

*   [Create a table bucket.](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-buckets-create.html)
    
*   Attach the [AWSLakeFormationDataAdmin](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSLakeFormationDataAdmin.html) AWS managed policy to your AWS Identity and Access Management (IAM) principal to make that user a data lake administrator. For more information about how to create a data lake administrator, see [Create a data lake administrator](https://docs.aws.amazon.com/lake-formation/latest/dg/initial-lf-config.html#create-data-lake-admin) in the _AWS Lake Formation Developer Guide_.
    
*   Add permissions for the `glue:PassConnection` operation to your IAM principal.
    
*   Add permissions for the `lakeformation:RegisterResource` and `lakeformation:RegisterResourceWithPrivilegedAccess` operations to your IAM principal.
    
*   [Update to the latest version of the AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html#getting-started-install-instructions).
    

###### Important

When creating tables, make sure that you use all lowercase letters in your table names and table definitions. For example, make sure that your column names are all lowercase. If your table name or table definition contains capital letters, the table isn't supported by AWS Lake Formation or the AWS Glue Data Catalog. In this case, your table won't be visible to AWS analytics services such as Amazon Athena, even if your table buckets are integrated with AWS analytics services.

If your table definition contains capital letters, you receive the following error message when running a `SELECT` query in Athena: **`"GENERIC_INTERNAL_ERROR: Get table request failed: com.amazonaws.services.glue.model.ValidationException: Unsupported Federation Resource - Invalid table or column names."`**

Integrating table buckets with AWS analytics services


-------------------------------------------------------

This integration must be done once per AWS Region.

###### Important

The AWS analytics services integration now uses the `WithPrivilegedAccess` option in the `registerResource` Lake Formation API operation to register S3 table buckets. The integration also now creates the `s3tablescatalog` catalog in the AWS Glue Data Catalog by using the `AllowFullTableExternalDataAccess` option in the `CreateCatalog` AWS Glue API operation.

If you set up the integration with the preview release, you can continue to use your current integration. However, the updated integration process provides performance improvements, so we recommend migrating. To migrate to the updated integration, see [Migrating to the updated integration process](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#migrate-integrate-console).

Using the S3 console
--------------------

Using the AWS CLI
-----------------

###### To integrate table buckets using the AWS CLI

The following steps show how to use the AWS CLI to integrate table buckets. To use these steps, replace the `` `user input placeholders` `` with your own information.

1.  Create a table bucket.
    
    ``aws s3tables create-table-bucket \
    --region `us-east-1` \
    --name `amzn-s3-demo-table-bucket` ``
    
2.  Create an IAM service role that allows Lake Formation to access your table resources.
    
    1.  Create a file called `Role-Trust-Policy.json` that contains the following trust policy:
        
        ``{
            "Version": "2012-10-17",
            "Statement": [
              {
                "Sid": "LakeFormationDataAccessPolicy",
                "Effect": "Allow",
                "Principal": {
                  "Service": "lakeformation.amazonaws.com"
                },
                "Action": [
                    "sts:AssumeRole",
                    "sts:SetContext",
                    "sts:SetSourceIdentity"
                ],
                "Condition": {
                  "StringEquals": {
                    "aws:SourceAccount": "`111122223333`"
                  }
                }
              }
            ]
        }``
        
        Create the IAM service role by using the following command:
        
        ``aws iam create-role \
        --role-name `S3TablesRoleForLakeFormation` \
        --assume-role-policy-document file://`Role-Trust-Policy.json` `` 
        
    2.  Create a file called `LF-GluePolicy.json` that contains the following policy:
        
        ``{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "LakeFormationPermissionsForS3ListTableBucket",
                    "Effect": "Allow",
                    "Action": [
                        "s3tables:ListTableBuckets"
                    ],
                    "Resource": [
                        "*"
                    ]
                },
                {
                    "Sid": "LakeFormationDataAccessPermissionsForS3TableBucket",
                    "Effect": "Allow",
                    "Action": [
                        "s3tables:CreateTableBucket",
                        "s3tables:GetTableBucket",
                        "s3tables:CreateNamespace",
                        "s3tables:GetNamespace",
                        "s3tables:ListNamespaces",
                        "s3tables:DeleteNamespace",
                        "s3tables:DeleteTableBucket",
                        "s3tables:CreateTable",
                        "s3tables:DeleteTable",
                        "s3tables:GetTable",
                        "s3tables:ListTables",
                        "s3tables:RenameTable",
                        "s3tables:UpdateTableMetadataLocation",
                        "s3tables:GetTableMetadataLocation",
                        "s3tables:GetTableData",
                        "s3tables:PutTableData"
                    ],
                    "Resource": [
                        "arn:aws:s3tables:`us-east-1`:`111122223333`:bucket/*"
                    ]
                }
            ]
        }``
        
        Attach the policy to the role by using the following command:
        
        ``aws iam put-role-policy \
        --role-name `S3TablesRoleForLakeFormation`  \
        --policy-name LakeFormationDataAccessPermissionsForS3TableBucket \
        --policy-document file://`LF-GluePolicy.json` ``
        
3.  Create a file called `input.json` that contains the following:
    
    ``{
        "ResourceArn": "arn:aws:s3tables:`us-east-1`:`111122223333`:bucket/*",
    
        "WithFederation": true,
        "RoleArn": "arn:aws:iam::`111122223333`:role/`S3TablesRoleForLakeFormation`"
    }`` 
    
    Register table buckets with Lake Formation by using the following command:
    
    ``aws lakeformation register-resource \
    --region `us-east-1` \
    --with-privileged-access \
    --cli-input-json file://`input.json` ``
    
4.  Create a file called `catalog.json` that contains the following catalog:
    
    ``{
       "Name": "s3tablescatalog",
       "CatalogInput": {
          "FederatedCatalog": {
              "Identifier": "arn:aws:s3tables:`us-east-1`:`111122223333`:bucket/*",
              "ConnectionName": "aws:s3tables"
           },
           "CreateDatabaseDefaultPermissions":[],
           "CreateTableDefaultPermissions":[],
           "AllowFullTableExternalDataAccess": "True"
       }
    }`` 
    
    Create the `s3tablescatalog` catalog by using the following command. Creating this catalog populates the AWS Glue Data Catalog with objects corresponding to table buckets, namespaces, and tables.
    
    ``aws glue create-catalog \
    --region `us-east-1` \
    --cli-input-json file://`catalog.json` ``
    
5.  Verify that the `s3tablescatalog` catalog was added in AWS Glue by using the following command:
    
    `aws glue get-catalog --catalog-id s3tablescatalog`
    

Migrating to the updated integration process
--------------------------------------------

###### Note

If you want to work with SSE-KMS encrypted tables in integrated AWS analytics services, the role you use needs to have permission to use your AWS KMS key for encryption operations. For more information, see [Granting IAM principals permissions to work with encrypted tables in integrated AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-kms-permissions.html#tables-kms-integration-permissions).

###### Next steps

*   [Create a namespace](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-namespace-create.html).
    
*   [Create a table](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-create.html).
    

Creating a resource link to your table's namespaces (Amazon Data Firehose)


----------------------------------------------------------------------------

To access your tables, Amazon Data Firehose needs a resource link that targets your table's namespace. A resource link is a Data Catalog object that acts as an alias or pointer to another Data Catalog resource, such as a database or table. The link is stored in the Data Catalog of the account or Region where it's created. For more information, see [How resource links work](https://docs.aws.amazon.com/lake-formation/latest/dg/resource-links-about.html) in the _AWS Lake Formation Developer Guide_.

After you've integrated your table buckets with the AWS analytics services, you can create resource links to work with your tables in Amazon Data Firehose. For more information about creating these links, see [Streaming data to tables with Amazon Data Firehose](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html).

Granting Lake Formation permissions on your table resources


-------------------------------------------------------------

After your table buckets are integrated with the AWS analytics services, Lake Formation manages access to your table resources. Lake Formation uses its own permissions model (Lake Formation permissions) that enables fine-grained access control for Data Catalog resources. Lake Formation requires that each IAM principal (user or role) be authorized to perform actions on Lake Formation–managed resources. For more information, see [Overview of Lake Formation permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-overview.html) in the _AWS Lake Formation Developer Guide_. For information about cross-account data sharing, see [Cross-account data sharing in Lake Formation](https://docs.aws.amazon.com/lake-formation/latest/dg/cross-account-permissions.html) in the _AWS Lake Formation Developer Guide_.

Before IAM principals can access tables in AWS analytics services, you must grant them Lake Formation permissions on those resources.

###### Note

If you're the user who performed the table bucket integration, you already have Lake Formation permissions to your tables. If you're the only principal who will access your tables, you can skip this step. You only need to grant Lake Formation permissions on your tables to other IAM principals. This allows other principals to access the table when running queries. For more information, see [Granting permission on a table or database](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#grant-lf-table).

You must grant other IAM principals Lake Formation permissions on your table resources to work with them in the following services:

*   Amazon Redshift
    
*   Amazon Data Firehose
    
*   Amazon QuickSight
    
*   Amazon Athena
    

### Granting permission on a table or database

You can grant a principal Lake Formation permissions on a table or database in a table bucket, either through the Lake Formation console or the AWS CLI.

###### Note

When you grant Lake Formation permissions on a Data Catalog resource to an external account or directly to an IAM principal in another account, Lake Formation uses the AWS Resource Access Manager (AWS RAM) service to share the resource. If the grantee account is in the same organization as the grantor account, the shared resource is available immediately to the grantee. If the grantee account is not in the same organization, AWS RAM sends an invitation to the grantee account to accept or reject the resource grant. Then, to make the shared resource available, the data lake administrator in the grantee account must use the AWS RAM console or AWS CLI to accept the invitation. For more information about cross-account data sharing, see [Cross-account data sharing in Lake Formation](https://docs.aws.amazon.com/lake-formation/latest/dg/cross-account-permissions.html) in the _AWS Lake Formation Developer Guide_.

*   Console
    
*   CLI
    

1.  Make sure that you're running the following AWS CLI commands as a data lake administrator. For more information, see [Create a data lake administrator](https://docs.aws.amazon.com/lake-formation/latest/dg/initial-lf-config.html#create-data-lake-admin) in the _AWS Lake Formation Developer Guide_.
    
2.  Run the following command to grant Lake Formation permissions on table in S3 table bucket to an IAM principal to access the table. To use this example, replace the `` `user input placeholders` `` with your own information.
    
    ```aws lakeformation grant-permissions \
    --region `us-east-1` \
    --cli-input-json \
    '{
        "Principal": {
            "DataLakePrincipalIdentifier": "`user or role ARN, for example, arn:aws:iam::account-id:role/example-role`"
        },
        "Resource": {
            "Table": {
                "CatalogId": "`account-id`:s3tablescatalog/`` `amzn-s3-demo-bucket` ``",
                "DatabaseName": "`S3 table bucket namespace, for example, test_namespace`",
                "Name": "`S3 table bucket table name, for example test_table`"
            }
        },
        "Permissions": [
            "ALL"
        ]
    }'```
    

---

Streaming data to tables with Amazon Data Firehose


======================================================


Amazon Data Firehose is a fully managed service for delivering real-time [streaming data](https://aws.amazon.com/streaming-data/) to destinations such as Amazon S3, Amazon Redshift, Amazon OpenSearch Service, Splunk, Apache Iceberg tables, and custom HTTP endpoints or HTTP endpoints owned by supported third-party service providers. With Amazon Data Firehose, you don't need to write applications or manage resources. You configure your data producers to send data to Firehose, and it automatically delivers the data to the destination that you specified. You can also configure Firehose to transform your data before delivering it. To learn more about Amazon Data Firehose, see [What is Amazon Data Firehose?](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)

Complete these steps to set up Firehose streaming to tables in S3 table buckets:

1.  [Integrate your table buckets with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html).
    
2.  Configure Firehose to deliver data into your S3 tables. To do so, you [create an AWS Identity and Access Management (IAM) service role that allows Firehose to access your tables](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html#firehose-role-s3tables).
    
3.  Grant the Firehose service role explicit permissions to your table or table's namespace. For more information, see [Grant Lake Formation permissions on your table resources](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#grant-permissions-tables).
    
4.  [Create a Firehose stream that routes data to your table.](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html#firehose-stream-tables)
    

Creating a role for Firehose to use S3 tables as a destination


----------------------------------------------------------------

Firehose needs an IAM [service role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-service.html) with specific permissions to access AWS Glue tables and write data to S3 tables. You need this provide this IAM role when you create a Firehose stream.

1.  Open the IAM console at [https://console.aws.amazon.com/iam/](https://console.aws.amazon.com/iam/).
    
2.  In the left navigation pane, choose **Policies**
    
3.  Choose **Create a policy**, and choose **JSON** in policy editor.
    
4.  Add the following inline policy that grants permissions to all databases and tables in your data catalog. If you want, you can give permissions only to specific tables and databases. To use this policy, replace the `` `user input placeholders` `` with your own information.
    
    ``{
      "Version": "2012-10-17",
      "Statement": [
        {
          "Sid": "S3TableAccessViaGlueFederation",
          "Effect": "Allow",
          "Action": [
            "glue:GetTable",
            "glue:GetDatabase",
            "glue:UpdateTable"
          ],
          "Resource": [
            "arn:aws:glue:`region`:`account-id`:catalog/s3tablescatalog/*",
            "arn:aws:glue:`region`:`account-id`:catalog/s3tablescatalog",
            "arn:aws:glue:`region`:`account-id`:catalog",
            "arn:aws:glue:`region`:`account-id`:database/*",
            "arn:aws:glue:`region`:`account-id`:table/*/*"
          ]
        },
        {
          "Sid": "S3DeliveryErrorBucketPermission",
          "Effect": "Allow",
          "Action": [
            "s3:AbortMultipartUpload",
            "s3:GetBucketLocation",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:ListBucketMultipartUploads",
            "s3:PutObject"
          ],
          "Resource": [
            "arn:aws:s3:::`error delivery bucket`",
            "arn:aws:s3:::`error delivery bucket`/*"
          ]
        },
        {
          "Sid": "RequiredWhenUsingKinesisDataStreamsAsSource",
          "Effect": "Allow",
          "Action": [
            "kinesis:DescribeStream",
            "kinesis:GetShardIterator",
            "kinesis:GetRecords",
            "kinesis:ListShards"
          ],
          "Resource": "arn:aws:kinesis:`region`:`account-id`:stream/`stream-name`"
        },
        {
          "Sid": "RequiredWhenDoingMetadataReadsANDDataAndMetadataWriteViaLakeformation",
          "Effect": "Allow",
          "Action": [
            "lakeformation:GetDataAccess"
          ],
          "Resource": "*"
        },
        {
          "Sid": "RequiredWhenUsingKMSEncryptionForS3ErrorBucketDelivery",
          "Effect": "Allow",
          "Action": [
            "kms:Decrypt",
            "kms:GenerateDataKey"
          ],
          "Resource": [
            "arn:aws:kms:`region`:`account-id`:key/`KMS-key-id`"
          ],
          "Condition": {
            "StringEquals": {
              "kms:ViaService": "s3.`region`.amazonaws.com"
            },
            "StringLike": {
              "kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::`error delivery bucket`/prefix*"
            }
          }
        },
        {
          "Sid": "LoggingInCloudWatch",
          "Effect": "Allow",
          "Action": [
            "logs:PutLogEvents"
          ],
          "Resource": [
            "arn:aws:logs:`region`:`account-id`:log-group:`log-group-name`:log-stream:`log-stream-name`"
          ]
        },
        {
          "Sid": "RequiredWhenAttachingLambdaToFirehose",
          "Effect": "Allow",
          "Action": [
            "lambda:InvokeFunction",
            "lambda:GetFunctionConfiguration"
          ],
          "Resource": [
            "arn:aws:lambda:`region`:`account-id`:function:`function-name`:`function-version`"
          ]
        }
      ]
    }``
    
    This policy has a statements that allow access to Kinesis Data Streams, invoking Lambda functions and access to AWS KMS keys. If you don't use any of these resources, you can remove the respective statements.
    
    If error logging is enabled, Firehose also sends data delivery errors to your CloudWatch log group and streams. For this, you must configure log group and log stream names. For log group and log stream names, see [Monitor Amazon Data Firehose Using CloudWatch Logs](https://docs.aws.amazon.com/firehose/latest/dev/controlling-access.html#using-iam-iceberg).
    
5.  After you create the policy, create an IAM role with **AWS service** as the **Trusted entity type**.
    
6.  For **Service or use case**, choose **Kinesis**. For **Use case** choose **Kinesis Firehose**.
    
7.  Choose **Next**, and then select the policy you created earlier.
    
8.  Give your role a name. Review your role details, and choose **Create role**. The role will have the following trust policy.
    
    `{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "sts:AssumeRole"
                ],
                "Principal": {
                    "Service": [
                        "firehose.amazonaws.com"
                    ]
                }
            }
        ]
    }`
    

Creating a Firehose stream to S3 tables


-----------------------------------------

The following procedure shows how to create a Firehose stream to deliver data to S3 tables using the console. The following prerequisites are required to set up a Firehose stream to S3 tables.

###### Prerequisites

*   [Integrate your table buckets with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html).
    
    *   [Create a namespace](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-namespace-create.html).
        
    *   [Create a table](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-create.html).
        
    
*   Create the [Role for Firehose to access S3 Tables](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-firehose.html#firehose-role-s3tables).
    
*   [Grant Lake Formation permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html#grant-permissions-tables) to the Firehose service role you created to access tables.
    

To provide routing information to Firehose when you configure a stream, you use your namespace as the database name and the name of a table in that namespace. You can use these values in the Unique key section of a Firehose stream configuration to route data to a single table. You can also use this values to route to a table using JSON Query expressions. For more information, see [Route incoming records to a single Iceberg table](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-format-input-record.html).

###### To set up a Firehose stream to S3 tables (Console)

1.  Open the Firehose console at [https://console.aws.amazon.com/firehose/](https://console.aws.amazon.com/firehose/).
    
2.  Choose **Create Firehose stream**.
    
3.  For **Source**, choose one of the following sources:
    
    *   Amazon Kinesis Data Streams
        
    *   Amazon MSK
        
    *   Direct PUT
        
    
4.  For **Destination**, choose **Apache Iceberg Tables**.
    
5.  Enter a **Firehose stream name**.
    
6.  Configure your **Source settings**.
    
7.  For **Destination settings**, choose **Current account** to stream to tables in your account or **Cross-account** for tables in another account.
    
    *   For tables in the **Current account**, select your S3 Tables catalog from the **Catalog** dropdown.
        
    *   For tables in a **Cross-account**, enter the **Catalog ARN** of the catalog you want to stream to in another account.
        
8.  Configure database and table names using **Unique Key configuration**, JSONQuery expressions, or in a Lambda function. For more information, refer to [Route incoming records to a single Iceberg table](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-format-input-record.html) and [Route incoming records to different Iceberg tables](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-format-input-record-different.html) in the _Amazon Data Firehose Developer Guide_.
    
9.  Under **Backup settings**, specify a **S3 backup bucket**.
    
10.  For **Existing IAM roles** under **Advanced settings**, select the IAM role you created for Firehose.
    
11.  Choose **Create Firehose stream**.
    

For more information about the other settings that you can configure for a stream, see [Set up the Firehose stream](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-stream.html) in the _Amazon Data Firehose Developer Guide_.