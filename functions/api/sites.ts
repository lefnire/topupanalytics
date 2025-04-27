import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { ulid } from "ulid"; // For generating unique site IDs

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Helper function for standard responses
const createResponse = (statusCode: number, body: any) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const useStripe = process.env.USE_STRIPE === 'true';
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  const claims = event.requestContext.authorizer?.jwt.claims;
  const userSub = claims?.sub as string | undefined;

  if (!userSub) {
    return createResponse(401, { error: "Unauthorized: Missing user identifier" });
  }

  const siteId = event.pathParameters?.site_id;
  const tableName = Resource.SitesTable.name;

  try {
    // --- Site Creation ---
    if (routeKey === "POST /api/sites") {
      const body = event.body ? JSON.parse(event.body) : {};
      // Note: 'plan' default is now handled directly in the Item below.
      // We still extract domains, is_active, allowed_fields from the body if provided.
      const { domains, is_active = true, allowed_fields = [] } = body;

      // --- Validation ---
      // Domains: Must be a non-empty array of strings
      if (!domains || !Array.isArray(domains) || domains.length === 0) {
        return createResponse(400, { error: "Bad Request: 'domains' must be a non-empty array." });
      }
      if (!domains.every(d => typeof d === 'string' && d.trim().length > 0)) {
          return createResponse(400, { error: "Bad Request: 'domains' must contain only non-empty strings." });
      }
      // is_active: Must be a boolean
      if (typeof is_active !== 'boolean') {
          return createResponse(400, { error: "Bad Request: 'is_active' must be a boolean." });
      }
      // allowed_fields: Must be an array (can be empty) of strings
      if (!Array.isArray(allowed_fields)) {
          return createResponse(400, { error: "Bad Request: 'allowed_fields' must be an array." });
      }
       if (!allowed_fields.every(f => typeof f === 'string')) {
          return createResponse(400, { error: "Bad Request: 'allowed_fields' must contain only strings." });
      }
      // --- End Validation ---

      const newSiteId = ulid();
      const itemToSave = {
        site_id: newSiteId,
        owner_sub: userSub,
        domains: domains, // Store as native list
        plan: 'free_tier', // Default plan
        request_allowance: 10000, // Default request allowance (updated)
        is_active: is_active, // Store as native boolean
        allowed_fields: allowed_fields, // Store as native list
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const putParams = new PutCommand({
        TableName: tableName,
        Item: itemToSave,
        ConditionExpression: "attribute_not_exists(site_id)", // Ensure it doesn't overwrite
      });

      await docClient.send(putParams);

      // Return the created item structure
      return createResponse(201, itemToSave);
    }

    // --- List Sites ---
    if (routeKey === "GET /api/sites") {
      const queryParams = new QueryCommand({
        TableName: tableName,
        IndexName: "ownerSubIndex",
        KeyConditionExpression: "owner_sub = :sub",
        ExpressionAttributeValues: {
          ":sub": userSub,
        },
        // Optionally add projection expression to limit fields returned
        // ProjectionExpression: "site_id, domains, created_at"
      });
      const { Items } = await docClient.send(queryParams);
      return createResponse(200, Items || []);
    }

    // --- Site Specific Operations (require siteId) ---
    if (!siteId) {
       // This case should ideally not be hit if routing is correct, but acts as a safeguard
       return createResponse(400, { error: "Bad Request: Missing site_id parameter" });
    }

    // --- Get Site Details ---
    if (routeKey === "GET /api/sites/{site_id}") {
      const getParams = new GetCommand({
        TableName: tableName,
        Key: { site_id: siteId },
      });
      const { Item } = await docClient.send(getParams);
      if (!Item || Item.owner_sub !== userSub) {
        return createResponse(404, { error: "Site not found or access denied" });
      }
      return createResponse(200, Item);
    }

    // --- Update Site ---
    if (routeKey === "PUT /api/sites/{site_id}") {
        const body = event.body ? JSON.parse(event.body) : {};
        const { domains, plan, is_active, allowed_fields } = body; // Add new updatable fields

        if (domains === undefined && plan === undefined && is_active === undefined && allowed_fields === undefined) {
            return createResponse(400, { error: "Bad Request: Requires 'domains', 'plan', 'is_active', or 'allowed_fields' in body." });
        }

        let updateExpression = "SET updated_at = :now";
        const expressionAttributeValues: Record<string, any> = { ":now": new Date().toISOString(), ":sub": userSub };
        const expressionAttributeNames: Record<string, string> = {}; // Needed if using reserved words

        if (domains !== undefined) {
            if (!Array.isArray(domains)) return createResponse(400, { error: "Bad Request: 'domains' must be an array." });
            updateExpression += ", domains = :domains"; // Use direct attribute name if not reserved
            expressionAttributeValues[":domains"] = JSON.stringify(domains); // Store as JSON string
        }
        if (plan !== undefined) {
            // If Stripe is disabled, only allow setting plan to 'free_tier' via this API
            if (!useStripe && plan !== 'free_tier') {
                console.warn(`Attempted to set plan to '${plan}' for site ${siteId} while USE_STRIPE=false. Only 'free_tier' is allowed.`);
                return createResponse(400, { error: "Bad Request: Plan can only be set to 'free_tier' when Stripe integration is disabled." });
            }
            updateExpression += ", plan = :plan"; // Use direct attribute name if not reserved
            expressionAttributeValues[":plan"] = plan;
        }
        if (is_active !== undefined) {
            if (typeof is_active !== 'boolean') return createResponse(400, { error: "Bad Request: 'is_active' must be a boolean." });
            updateExpression += ", is_active = :is_active";
            expressionAttributeValues[":is_active"] = is_active ? 1 : 0; // Store as number
        }
        if (allowed_fields !== undefined) {
            if (!Array.isArray(allowed_fields)) return createResponse(400, { error: "Bad Request: 'allowed_fields' must be an array." });
            updateExpression += ", allowed_fields = :allowed_fields";
            expressionAttributeValues[":allowed_fields"] = JSON.stringify(allowed_fields); // Store as JSON string
        }

        const updateParams = new UpdateCommand({
            TableName: tableName,
            Key: { site_id: siteId },
            UpdateExpression: updateExpression,
            ConditionExpression: "owner_sub = :sub", // Ensure user owns the site
            ExpressionAttributeValues: expressionAttributeValues,
            ...(Object.keys(expressionAttributeNames).length > 0 && { ExpressionAttributeNames: expressionAttributeNames }), // Only add if needed
            ReturnValues: "ALL_NEW",
        });

        try {
            const { Attributes } = await docClient.send(updateParams);
            return createResponse(200, Attributes);
        } catch (error: any) {
            if (error.name === 'ConditionalCheckFailedException') {
                return createResponse(404, { error: "Site not found or access denied" });
            }
            throw error; // Re-throw other errors
        }
    }

    // --- Get Embed Script ---
    if (routeKey === "GET /api/sites/{site_id}/script") {
      const getParams = new GetCommand({
        TableName: tableName,
        Key: { site_id: siteId },
        ProjectionExpression: "owner_sub", // Only need owner_sub for verification
      });
      const { Item } = await docClient.send(getParams);
      if (!Item || Item.owner_sub !== userSub) {
        return createResponse(404, { error: "Site not found or access denied" });
      }

      // Use the new ROUTER_URL environment variable
      const routerUrl = process.env.ROUTER_URL;
      if (!routerUrl) {
          console.error("ROUTER_URL environment variable not set!");
          return createResponse(500, { error: "Internal Server Error: Configuration missing." });
      }

      // Construct the full ingest URL
      const ingestUrl = `${routerUrl.replace(/\/$/, '')}/api/event`; // Ensure no double slash

      // Simple script example - enhance as needed
      const scriptContent = `
(function() {
  var d = document, s = d.createElement('script');
  s.src = '${ingestUrl}?sid=${siteId}'; // Use 'sid' query param as decided for ingestFn
  s.async = true;
  d.getElementsByTagName('head')[0].appendChild(s);
  console.log('TopUp Analytics Loaded for site: ${siteId}');
})();
      `;
      // Return as JavaScript content type
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/javascript" },
        body: scriptContent.trim(),
      };
    }

    // Fallback for unhandled routes within this handler's scope
    return createResponse(404, { error: `Not Found: Route ${routeKey} not handled.` });

  } catch (error: any) {
    console.error("Error processing request:", error);
    // Basic error handling, refine as needed
    if (error.name === 'ConditionalCheckFailedException') {
         return createResponse(409, { error: "Conflict: Site already exists or condition failed." });
    }
    return createResponse(500, { error: "Internal Server Error", details: error.message });
  }
};