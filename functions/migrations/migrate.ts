import { execSync } from 'child_process';

/**
 * Lambda handler function to execute database migrations using drizzle-kit.
 * This function is intended to be run during deployment via SST's `Function` construct.
 * It relies on `drizzle.config.ts` being present and configured to use
 * environment variables for database credentials, which are injected by SST.
 */
export const handler = async () => {
  try {
    console.log('Starting database migrations...');

    // Execute the drizzle-kit migrate command.
    // 'npx' ensures that drizzle-kit is used, even if not globally installed,
    // assuming it's available in the node_modules packaged with the Lambda.
    // 'stdio: inherit' pipes the command's output/error streams to the Lambda's logs.
    execSync('npx drizzle-kit migrate', {
      encoding: 'utf-8',
      stdio: 'inherit', // Show migration output in CloudWatch logs
      // Consider setting cwd if the drizzle config/migrations aren't at the root
      // cwd: process.cwd(), // Usually the default is fine in Lambda
    });

    console.log('Database migrations command executed successfully.');

    // Optionally return a success indicator
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Migrations completed successfully.' }),
    };
  } catch (error) {
    console.error('Database migration failed:', error);

    // Ensure the error is propagated to signal failure in the deployment process
    throw new Error(`Migration failed: ${error.message || error}`);
  }
};