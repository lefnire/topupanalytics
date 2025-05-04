### Frontend Dashboard
---
*   The frontend dashboard (built with React/Vite) uses Zustand for state management.
    *   State is split into two main stores:
        *   `analyticsHttpStore.ts`: Manages site/preference data fetching, selected site/range, UI state (tabs, modals), and persists selections to `localStorage`.
        *   `analyticsSqlStore.ts`: Manages the DuckDB WASM instance, orchestrates fetching API data, triggers data loading and aggregations via `analyticsSql.ts`, and manages related state. It subscribes to the HTTP store for site/range changes.
        *   `analyticsSql.ts`: Contains functions for direct DuckDB interaction, including creating tables/views, loading data, and executing aggregation queries.