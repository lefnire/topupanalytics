import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Resource } from 'sst'; // SST provides DB connection details via Resource binding
import * as schema from './schema';

// --- Connection Pooling Strategy for Lambda ---
// Create the pool outside the handler scope so it can be reused across invocations
// for the same Lambda container instance. This is crucial for performance and
// managing connections efficiently in a serverless environment without overwhelming
// the database.

// For applications with high concurrency or needing more robust connection management,
// consider using AWS RDS Proxy. RDS Proxy handles pooling centrally, improving
// scalability and resilience.

// Placeholder logic: Use SST Resource binding for actual credentials.
// These values (host, port, user, password, database) will be injected by SST at runtime
// when the 'database' resource is linked to the Lambda function.
const pool = new Pool({
  host: Resource.Database.host,
  // Ensure port is parsed as a number if necessary, though 'pg' might handle string ports.
  // Assuming Resource.Database.port provides the correct type or a string convertible to number.
  port: typeof Resource.Database.port === 'string' ? parseInt(Resource.Database.port, 10) : Resource.Database.port,
  user: Resource.Database.user,
  password: Resource.Database.password,
  database: Resource.Database.database,

  // --- Pool Configuration for Lambda ---
  // Adjust 'max' based on expected concurrency and database instance size.
  // A lower 'max' (e.g., 1-5) is often recommended for direct Lambda-to-DB connections
  // to prevent exhausting connections on the database server due to many concurrent
  // Lambda executions spinning up new pools. RDS Proxy mitigates this.
  max: 2,
  // Close idle connections relatively quickly to free up resources.
  idleTimeoutMillis: 30000, // 30 seconds
  // Timeout for acquiring a connection from the pool.
  connectionTimeoutMillis: 5000, // 5 seconds
});

// Initialize Drizzle ORM client with the node-postgres pool and the defined schema.
export const db = drizzle(pool, { schema, logger: process.env.NODE_ENV === 'development' }); // Enable logging in dev

// Re-export the schema for easier access in other modules.
export { schema };

// --- Graceful Shutdown ---
// While Lambdas are typically short-lived, in environments where the process might
// persist longer or handle shutdown signals (e.g., Fargate, local dev),
// draining the pool is good practice.
// process.on('SIGTERM', async () => {
//   console.log('SIGTERM received, draining connection pool...');
//   await pool.end();
//   console.log('Pool drained.');
//   process.exit(0);
// });
// process.on('SIGINT', async () => { // Handle Ctrl+C in local dev
//   console.log('SIGINT received, draining connection pool...');
//   await pool.end();
//   console.log('Pool drained.');
//   process.exit(0);
// });