import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2 } from 'aws-lambda'; // Added APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2
import * as queryHandler from '../analytics/query';
import * as sitesHandler from './sites';
import * as preferencesHandler from './preferences';

// Conditionally import stripe handler
// Use the correct handler type from the imported module
let stripeHandler: { handler: APIGatewayProxyHandlerV2 } | null = null;
if (process.env.USE_STRIPE === 'true') {
  // Using require for synchronous loading in Lambda environment
  try {
    stripeHandler = require('./stripe');
  } catch (err) {
     console.error("Failed to load stripe handler:", err);
     // Stripe routes will not be available if loading fails.
  }
}

// Update handler signature to expect the event with JWT Authorizer context
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer, context: Context): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath;

  console.log(`Received request: ${method} ${rawPath}`);

  // Handle CORS preflight requests first
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*', // Adjust as needed for security
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token', // Added common headers
      },
    };
  }

  try {
    // --- Analytics ---
    if (rawPath === '/api/query' && method === 'GET') {
      // Pass event, context, and a dummy callback to satisfy the Handler type
      // Assert the return type to match the master handler's promise requirement
      return await queryHandler.handler(event, context, () => {}) as Promise<APIGatewayProxyResultV2>;
    }

    // --- Sites ---
    // Matches /api/sites, /api/sites/{site_id}, /api/sites/{site_id}/script
    // The sites.handler itself should differentiate based on method and pathParameters
    if (rawPath.startsWith('/api/sites')) {
      // Pass event, context, and a dummy callback to satisfy the Handler type
      // Assert the return type to match the master handler's promise requirement
      return await sitesHandler.handler(event, context, () => {}) as Promise<APIGatewayProxyResultV2>;
    }

    // --- User Preferences ---
    if (rawPath === '/api/user/preferences') {
      if (method === 'GET' || method === 'PUT') {
        // Pass event, context, and a dummy callback to satisfy the Handler type
        // Assert the return type to match the master handler's promise requirement
        return await preferencesHandler.handler(event, context, () => {}) as Promise<APIGatewayProxyResultV2>;
      }
}