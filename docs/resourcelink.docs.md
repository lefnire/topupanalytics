Creating resource links


===========================


Resource links are Data Catalog objects that are links to metadata databases and tables—typically to shared databases and tables from other AWS accounts. They help to enable cross-account access to data in the data lake across all AWS Regions.

###### Note

Lake Formation supports querying Data Catalog tables across AWS Regions. You can access the Data Catalog databases and tables from any AWS Region by creating resource links in those regions that point to shared databases and tables in different Regions.

###### Topics

*   [How resource links work in Lake Formation](https://docs.aws.amazon.com/lake-formation/latest/dg/resource-links-about.html)
    
*   [Creating a resource link to a shared Data Catalog table](https://docs.aws.amazon.com/lake-formation/latest/dg/create-resource-link-table.html)
    
*   [Creating a resource link to a shared Data Catalog database](https://docs.aws.amazon.com/lake-formation/latest/dg/create-resource-link-database.html)
    
*   [Resource link handling in AWS Glue APIs](https://docs.aws.amazon.com/lake-formation/latest/dg/resource-links-glue-apis.html)

---

How resource links work in Lake Formation


=============================================

A _resource link_ is a Data Catalog object that is a link to a local or shared database or table. After you create a resource link to a database or table, you can use the resource link name wherever you would use the database or table name. Along with tables that you own or tables that are shared with you, table resource links are returned by `glue:GetTables()` and appear as entries on the **Tables** page of the Lake Formation console. Resource links to databases act in a similar manner.

Creating a resource link to a database or table enables you to do the following:

*   Assign a different name to a database or table in your Data Catalog. This is especially useful if different AWS accounts share databases or tables with the same name, or if multiple databases in your account have tables with the same name.
    
*   Access the Data Catalog databases and tables from any AWS Region by creating resource links in those regions pointing to the database and tables in another region. You can run queries in any region with these resource links using Athena, Amazon EMR and run AWS Glue ETL Spark jobs, without copying source data nor the metadata in Glue Data Catalog.
    
*   Use integrated AWS services such as Amazon Athena and Amazon Redshift Spectrum to run queries that access shared databases or tables. Some integrated services can't directly access databases or tables across accounts. However, they can access resource links in your account to databases and tables in other accounts.
    

###### Note

You don't need to create a resource link to reference a shared database or table in AWS Glue extract, transform, and load (ETL) scripts. However, to avoid ambiguity when multiple AWS accounts share a database or table with the same name, you can either create and use a resource link or specify the catalog ID when invoking ETL operations.

The following example shows the Lake Formation console **Tables** page, which lists two resource links. Resource link names are always displayed in italics. Each resource link is displayed along with the name and owner of its linked shared resource. In this example, a data lake administrator in AWS account 1111-2222-3333 shared the `inventory` and `incidents` tables with account 1234-5678-9012. A user in that account then created resource links to those shared tables.

![The Tables page shows two resource links. The resource link name is shown under the Name column, the shared table name is shown under the Shared resource column, and the account that shared the table is shown under the Shared resource owner column.](https://docs.aws.amazon.com/images/lake-formation/latest/dg/images/tables-with-links.png)

The following are notes and restrictions on resource links:

*   Resource links are required to enable integrated services such as Athena and Redshift Spectrum to query the underlying data of shared tables. Queries in these integrated services are constructed against the resource link names.
    
*   Assuming that the setting **Use only IAM access control for new tables in this database** is turned off for the containing database, only the principal who created a resource link can view and access it. To enable other principals in your account to access a resource link, grant the `DESCRIBE` permission on it. To enable others to drop a resource link, grant the `DROP` permission on it. Data lake administrators can access all resource links in the account. To drop a resource link created by another principal, the data lake administrator must first grant themselves the `DROP` permission on the resource link. For more information, see [Lake Formation permissions reference](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-reference.html).
    
    ###### Important
    
    Granting permissions on a resource link doesn't grant permissions on the target (linked) database or table. You must grant permissions on the target separately.
    
*   To create a resource link, you need the Lake Formation `CREATE_TABLE` or `CREATE_DATABASE` permission, as well as the `glue:CreateTable` or `glue:CreateDatabase` AWS Identity and Access Management (IAM) permission.
    
*   You can create resource links to local (owned) Data Catalog resources, as well as to resources shared with your AWS account.
    
*   When you create a resource link, no check is performed to see if the target shared resource exists or whether you have cross-account permissions on the resource. This enables you to create the resource link and shared resource in any order.
    
*   If you delete a resource link, the linked shared resource is not dropped. If you drop a shared resource, resource links to that resource are not deleted.
    
*   It's possible to create resource link chains. However, there is no value in doing so, because the APIs follow only the first resource link.

---

Creating a resource link to a shared Data Catalog table


===========================================================


You can create a resource link to a shared table in any AWS Region by using the AWS Lake Formation console, API, or AWS Command Line Interface (AWS CLI).

###### To create a resource link to a shared table (console)

1.  Open the AWS Lake Formation console at [https://console.aws.amazon.com/lakeformation/](https://console.aws.amazon.com/lakeformation/). Sign in as a principal who has the Lake Formation `CREATE_TABLE` permission on the database to contain the resource link.
    
2.  In the navigation pane, choose **Tables** under Data Catalog, and then choose **Create**, **Resource link**.
    
3.  On the **Create resource link** page, provide the following information:
    
    **Resource link name**
    
    Enter a name that adheres to the same rules as a table name. The name can be the same as the target shared table.
    
    **Database**
    
    The database in the local Data Catalog to contain the resource link.
    
    **Shared table owner Region**
    
    If you are creating the resource link in a different Region, select the region of the target shared table.
    
    **Shared table**
    
    Select a shared table from the list, or enter a local (owned) or shared table name.
    
    The list contains all the tables shared with your account. Note the database and owner account ID that are listed with each table. If you don't see a table that you know was shared with your account, check the following:
    
    *   If you aren't a data lake administrator, check that the data lake administrator granted you Lake Formation permissions on the table.
        
    *   If you are a data lake administrator, and your account is not in the same AWS organization as the granting account, ensure that you have accepted the AWS Resource Access Manager (AWS RAM) resource share invitation for the table. For more information, see [Accepting a resource share invitation from AWS RAM](https://docs.aws.amazon.com/lake-formation/latest/dg/accepting-ram-invite.html).
        
    
    **Shared table's database**
    
    If you selected a shared table from the list, this field is populated with the shared table's database in the external account. Otherwise, enter a local database (for a resource link to a local table) or the shared table's database in the external account.
    
    **Shared table owner**
    
    If you selected a shared table from the list, this field is populated with the shared table's owner account ID. Otherwise, enter your AWS account ID (for a resource link to a local table) or the ID of the AWS account that shared the table.
    
4.  Choose **Create** to create the resource link.
    
    You can then view the resource link name under the **Name** column on the **Tables** page.
    
5.  (Optional) Grant the Lake Formation `DESCRIBE` permission on the resource link to principals that must be able to view the link and access the target table.
    
    However, granting permissions on a resource link doesn't grant permissions on the target (linked) database or table. You must grant permissions on the target database separately for the table/resource link to be visible in Athena.
    

###### To create a resource link to a shared table in the same Region (AWS CLI)

1.  Enter a command similar to the following.
    
    `aws glue create-table --database-name myissues --table-input '{"Name":"my_customers","TargetTable":{"CatalogId":"111122223333","DatabaseName":"issues","Name":"customers"}}'`
    
    This command creates a resource link named `my_customers` to the shared table `customers`, which is in the database `issues` in the AWS account 1111-2222-3333. The resource link is stored in the local database `myissues`.
    
2.  (Optional) Grant the Lake Formation `DESCRIBE` permission on the resource link to principals that must be able to view the link and access the target table.
    
    However, granting permissions on a resource link doesn't grant permissions on the target (linked) table. You must grant permissions on the target database separately for the table/resource link to be visible in Athena.
    

###### To create a resource link to a shared table in a different Region (AWS CLI)

1.  Enter a command similar to the following.
    
    `aws glue create-table --region eu-west-1 --cli-input-json '{
        "CatalogId": "111122223333",
        "DatabaseName": "ireland_db",
        "TableInput": {
            "Name": "rl_useast1salestb_ireland",
            "TargetTable": {
                "CatalogId": "444455556666",
                "DatabaseName": "useast1_salesdb",
                "Region": "us-east-1",
                "Name":"useast1_salestb"
            }
        }
    }‘`
    
    This command creates a resource link named `rl_useast1salestb_ireland` in the Europe (Ireland) Region to the shared table `useast1_salestb`, which is in the database `useast1_salesdb` in the AWS account 444455556666 in the US East (N. Virginia) Region. The resource link is stored in the local database `ireland_db`.
    
2.  Grant the Lake Formation `DESCRIBE` permission to principals that must be able to view the link and access the link target through the link.
    
    However, granting permissions on a resource link doesn't grant permissions on the target (linked) table. You must grant permissions on the target table separately for the table/resource link to be visible in Athena.

---

Creating a resource link to a shared Data Catalog database


==============================================================

 [PDF](https://docs.aws.amazon.com/pdfs/lake-formation/latest/dg/lake-formation-dg.pdf#create-resource-link-database)

Focus mode

You can create a resource link to a shared database by using the AWS Lake Formation console, API, or AWS Command Line Interface (AWS CLI).

###### To create a resource link to a shared database (console)

1.  Open the AWS Lake Formation console at [https://console.aws.amazon.com/lakeformation/](https://console.aws.amazon.com/lakeformation/). Sign in as a data lake administrator or as a database creator.
    
    A database creator is a principal who has been granted the Lake Formation `CREATE_DATABASE` permission.
    
2.  In the navigation pane, choose **Databases**, and then choose **Create**, **Resource link**.
    
3.  On the **Create resource link** page, provide the following information:
    
    **Resource link name**
    
    Enter a name that adheres to the same rules as a database name. The name can be the same as the target shared database.
    
    **Destination catalog**
    
    Select the destination catalog for the database resource link.
    
    **Shared database owner Region**
    
    If you are creating the resource link in a different Region, select the Region of the target shared database.
    
    **Shared database**
    
    Choose a database from the list, or enter a local (owned) or shared database name.
    
    The list contains all the databases shared with your account. Note the owner account ID that is listed with each database. If you don't see a database that you know was shared with your account, check the following:
    
    *   If you aren't a data lake administrator, check that the data lake administrator granted you Lake Formation permissions on the database.
        
    *   If you are a data lake administrator, and your account is not in the same AWS organization as the granting account, ensure that you have accepted the AWS Resource Access Manager (AWS RAM) resource share invitation for the database. For more information, see [Accepting a resource share invitation from AWS RAM](https://docs.aws.amazon.com/lake-formation/latest/dg/accepting-ram-invite.html).
        
    
    **Shared database owner**
    
    If you selected a shared database from the list, this field is populated with the shared database's owner account ID. Otherwise, enter your AWS account ID (for a resource link to a local database) or the ID of the AWS account that shared the database.
    
    **Shared database's catalog ID**
    
    Enter the catalog ID for the shared database. When creating a resource link to a databse that's shared from another AWS account, you need to specify this catalog ID to identify which account's Data Catalog contains the source database.
    
    When you select a shared database from the dropdown menu, the system automatically fills in the catalog ID of the account that owns and has shared that database with you.
    
    ![The Database details dialog box has the Resource link radio button selected, with the following fields filled in: Resource link name, Shared database, Shared database owner ID. Shared database owner ID is disabled (read-only).](https://docs.aws.amazon.com/images/lake-formation/latest/dg/images/create-resource-link-db.png)
    
4.  Choose **Create** to create the resource link.
    
    You can then view the resource link name under the **Name** column on the **Databases** page.
    
5.  (Optional) Grant the Lake Formation `DESCRIBE` permission on the resource link to principals from the Europe (Ireland) Region that must be able to view the link and access the target database.
    
    However, granting permissions on a resource link doesn't grant permissions on the target (linked) database or table. You must grant permissions on the target database separately for the table/resource link to be visible in Athena.
    

###### To create a resource link to a shared database in the same Region(AWS CLI)

1.  Enter a command similar to the following.
    
    `aws glue create-database --database-input '{"Name":"myissues","TargetDatabase":{"CatalogId":"111122223333","DatabaseName":"issues"}}'` 
    
    This command creates a resource link named `myissues` to the shared database `issues`, which is in the AWS account 1111-2222-3333.
    
2.  (Optional) Grant the Lake Formation `DESCRIBE` permission to principals on the resource link that must be able to view the link and access the target database or table.
    
    However, granting permissions on a resource link doesn't grant permissions on the target (linked) database or table. You must grant permissions on the target database separately for the table/resource link to be visible in Athena.
    

###### To create a resource link to a shared database in a different Region(AWS CLI)

1.  Enter a command similar to the following.
    
    `aws glue create-database --region eu-west-1 --cli-input-json '{
        "CatalogId": "111122223333",
        "DatabaseInput": {
          "Name": "rl_useast1shared_irelanddb",
          "TargetDatabase": {
              "CatalogId": "444455556666",
              "DatabaseName": "useast1shared_db",
              "Region": "us-east-1"
           }
        }
    }'`
    
    This command creates a resource link named `rl_useast1shared_irelanddb` in the AWS account 111122223333 in the Europe (Ireland) Region to the shared database `useast1shared_db`, which is in the AWS account 444455556666 in the US East (N. Virginia) Region.
    
2.  Grant the Lake Formation `DESCRIBE` permission to principals from the Europe (Ireland) Region that must be able to view the link and access the link target through the link.

---

Resource link handling in AWS Glue APIs


===========================================

 [PDF](https://docs.aws.amazon.com/pdfs/lake-formation/latest/dg/lake-formation-dg.pdf#resource-links-glue-apis)

Focus mode

The following tables explain how the AWS Glue Data Catalog APIs handle database and table resource links. For all `Get*` API operations, only databases and tables that the caller has permissions on get returned. Also, when accessing a target database or table through a resource link, you must have both AWS Identity and Access Management (IAM) and Lake Formation permissions on both the target and the resource link. The Lake Formation permission that is required on resource links is `DESCRIBE`. For more information, see [DESCRIBE](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-reference.html#perm-describe).

Database API operations

API operation

Resource link handling

`CreateDatabase`

If the database is a resource link, creates the resource link to the designated target database.

`UpdateDatabase`

If the designated database is a resource link, follows the link and updates the target database. If the resource link must be modified to link to a different database, you must delete it and create a new one.

`DeleteDatabase`

Deletes the resource link. It doesn't delete the linked (target) database.

`GetDatabase`

If the caller has permissions on the target, follows the link to return the target's properties. Otherwise, it returns the properties of the link.

`GetDatabases`

Returns a list of databases, including resource links. For each resource link in the result set, the operation follows the link to get the properties of the link target. You must specify `ResourceShareType` \= `ALL` to see the databases shared with your account.

Table API operations

API operation

Resource link handling

`CreateTable`

If the database is a resource link, follows the database link and creates a table in the target database. If the table is a resource link, the operation creates the resource link in the designated database. Creating a table resource link through a database resource link is not supported.

`UpdateTable`

If either the table or designated database is a resource link, updates the target table. If both the table and database are resource links, the operation fails.

`DeleteTable`

If the designated database is a resource link, follows the link and deletes the table or table resource link in the target database. If the table is a resource link, the operation deletes the table resource link in the designated database. Deleting a table resource link does not delete the target table.

`BatchDeleteTable`

Same as `DeleteTable`.

`GetTable`

If the designated database is a resource link, follows the database link and returns the table or table resource link from the target database. Otherwise, if the table is a resource link, the operation follows the link and returns the target table properties.

`GetTables`

If the designated database is a resource link, follows the database link and returns the tables and table resource links from the target database. If the target database is a shared database from another AWS account, the operation returns only the shared tables in that database. It doesn't follow the table resource links in the target database. Otherwise, if the designated database is a local (owned) database, the operation returns all the tables in the local database, and follows each table resource link to return target table properties.

`SearchTables`

Returns tables and table resource links. It doesn't follow links to return target table properties. You must specify `ResourceShareType` \= `ALL` to see tables shared with your account.

`GetTableVersion`

Same as `GetTable`.

`GetTableVersions`

Same as `GetTable`.

`DeleteTableVersion`

Same as `DeleteTable`.

`BatchDeleteTableVersion`

Same as `DeleteTable`.

Partition API operations

API operation

Resource link handling

`CreatePartition`

If the designated database is a resource link, follows the database link and creates a partition in the designated table in the target database. If the table is a resource link, the operation follows the resource link and creates the partition in the target table. Creating a partition through both a table resource link and database resource link is not supported.

`BatchCreatePartition`

Same as `CreatePartition`.

`UpdatePartition`

If the designated database is a resource link, follows the database link and updates the partition in the designated table in the target database. If the table is a resource link, the operation follows the resource link and updates the partition in the target table. Updating a partition through both a table resource link and database resource link is not supported.

`DeletePartition`

If the designated database is a resource link, follows the database link and deletes the partition in the designated table in the target database. If the table is a resource link, the operation follows the resource link and deletes the partition in the target table. Deleting a partition through both a table resource link and database resource link is not supported.

`BatchDeletePartition`

Same as `DeletePartition`.

`GetPartition`

If the designated database is a resource link, follows the database link and returns partition information from the designated table. Otherwise, if the table is a resource link, the operation follows the link and returns partition information. If both the table and database are resource links, it returns an empty result set.

`GetPartitions`

If the designated database is a resource link, follows the database link and returns partition information for all partitions in the designated table. Otherwise, if the table is a resource link, the operation follows the link and returns partition information. If both the table and database are resource links, it returns an empty result set.

`BatchGetPartition`

Same as `GetPartition`.

User-defined functions API operations

API operation

Resource Link Handling

(All API operations)

If the database is a resource link, follows the resource link and performs the operation on the target database.