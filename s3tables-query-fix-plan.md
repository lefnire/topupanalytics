# S3 Tables Athena Query Fix Plan

This document outlines the plan to resolve the `TABLE_NOT_FOUND` error when querying S3 Tables via Athena from the `query` Lambda function.

### Analysis of the Problem

The error `TABLE_NOT_FOUND: ... Table 'awsdatacatalog.topupanalyticslefnire_s3table_ns_link.events' does not exist` indicates that Athena is looking for a table named `events` inside a database named `topupanalyticslefnire_s3table_ns_link` within the standard `awsdatacatalog`.

The `sst.config.ts` correctly creates a Glue "Resource Link" with this name, which is intended to point to the S3 Table's namespace (`firehose_data_ns`). This setup is required for Kinesis Firehose to deliver data to the S3 Table, as per the documentation.

However, for querying data with Athena, the documentation specifies a different access pattern. S3 Tables are integrated with the AWS Glue Data Catalog through a special federated catalog named `s3tablescatalog`. To query a table, you must use a fully qualified 3-part name: `"s3tablescatalog/<your-bucket-name>"."<your-namespace>"."<your-table-name>"`.

The current code in `functions/analytics/query.ts` attempts to query Athena using the resource link, which is causing the `TABLE_NOT_FOUND` error because Athena isn't resolving the table through the link in this context.

### Proposed Plan

The plan is to modify `functions/analytics/query.ts` to align with the documented method for querying S3 Tables with Athena.

1.  **Update Athena Query Construction:** The `initialEventsQuery` and `eventsQuery` will be changed to use the 3-part table identifier. The query will be constructed like this:
    `FROM "s3tablescatalog/${process.env.S3_TABLE_BUCKET_NAME}"."${process.env.S3_TABLE_NAMESPACE_NAME}"."${process.env.TABLE_NAME}"`
    All the necessary components (`S3_TABLE_BUCKET_NAME`, `S3_TABLE_NAMESPACE_NAME`, etc.) are already available as environment variables in the function.

2.  **Adjust Athena Execution Context:** The `executeAthenaQuery` function will be updated to remove the `Database` specification from the `QueryExecutionContext`. Since the query will now use fully qualified names, this context setting is no longer needed.

This change specifically targets how Athena queries are performed from the Lambda function and does not alter the Firehose setup, which correctly relies on the resource link.

### Diagram of Query Paths

This diagram illustrates the current (failing) and proposed (working) query paths:

```mermaid
graph TD
    subgraph "AWS Glue Data Catalog"
        subgraph "Default Catalog (awsdatacatalog)"
            A[Resource Link: <br/> topup..._s3table_ns_link]
        end
        subgraph "Federated Catalog (s3tablescatalog)"
            B[Sub-catalog: <br/> topup...-s3-table-bucket] --> C{Database: <br/> firehose_data_ns};
            C --> D1[Table: events];
            C --> D2[Table: initial_events];
        end
    end

    subgraph "Services"
        Firehose --> |Writes via| A;
        Lambda_current[Query Lambda (Current)] -- "Failing Query Path" --> A;
        Lambda_proposed[Query Lambda (Proposed)] -- "Correct Query Path" --> B;
    end

    A -- "links to" --> C;

    style Firehose fill:#f9f,stroke:#333,stroke-width:2px
    style Lambda_current fill:#f99,stroke:#333,stroke-width:2px
    style Lambda_proposed fill:#9f9,stroke:#333,stroke-width:2px