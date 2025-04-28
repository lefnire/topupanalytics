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

// Define a type for the Site object for clarity
type Site = {
  site_id: string;
  owner_sub: string;
  name: string;
  domains: string[];
  plan: string;
  request_allowance: number;
  allowed_fields: string[];
  compliance_level?: 'yes' | 'maybe' | 'no'; // Updated compliance levels
  created_at: string;
  updated_at: string;
};

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
      // We extract name, domains, is_active, allowed_fields, compliance_level from the body if provided.
      const { name, domains, allowed_fields = [], compliance_level } = body;

      // --- Validation ---
      // Name: Must be a non-empty string
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return createResponse(400, { error: "Bad Request: 'name' must be a non-empty string." });
      }
      // Domains: Must be a non-empty array of strings
      if (!domains || !Array.isArray(domains) || domains.length === 0) {
        return createResponse(400, { error: "Bad Request: 'domains' must be a non-empty array." });
      }
      if (!domains.every(d => typeof d === 'string' && d.trim().length > 0)) {
          return createResponse(400, { error: "Bad Request: 'domains' must contain only non-empty strings." });
      }
      // allowed_fields: Must be an array (can be empty) of strings
      if (!Array.isArray(allowed_fields)) {
          return createResponse(400, { error: "Bad Request: 'allowed_fields' must be an array." });
      }
       if (!allowed_fields.every(f => typeof f === 'string')) {
          return createResponse(400, { error: "Bad Request: 'allowed_fields' must contain only strings." });
     }
     // compliance_level: Must be 'yes', 'maybe', or 'no' if provided
     const validComplianceLevels = ['yes', 'maybe', 'no'];
     if (compliance_level !== undefined && (typeof compliance_level !== 'string' || !validComplianceLevels.includes(compliance_level))) {
         return createResponse(400, { error: "Bad Request: 'compliance_level' must be either 'yes', 'maybe', or 'no'." });
     }
     // --- End Validation ---

     const newSiteId = ulid();
     // Use the Site type for the item
     const itemToSave: Site = {
       site_id: newSiteId,
       owner_sub: userSub,
       name: name.trim(), // Store trimmed name
       domains: domains, // Store as native list
       plan: 'free_tier', // Default plan
       request_allowance: 10000, // Default request allowance (updated)
       allowed_fields: allowed_fields, // Store as native list
       // Default to 'maybe' if not provided or invalid (though validation catches invalid)
       compliance_level: compliance_level && validComplianceLevels.includes(compliance_level) ? compliance_level : 'maybe',
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
      // Default compliance_level removed as per greenfield project requirements
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
      // Default compliance_level removed as per greenfield project requirements
      return createResponse(200, Item);
    }

    // --- Update Site ---
    if (routeKey === "PUT /api/sites/{site_id}") {
        const body = event.body ? JSON.parse(event.body) : {};
        const { name, domains, plan, allowed_fields, compliance_level } = body; // Add 'name' and 'compliance_level'

        if (name === undefined && domains === undefined && plan === undefined && allowed_fields === undefined && compliance_level === undefined) {
            return createResponse(400, { error: "Bad Request: Requires 'name', 'domains', 'plan', 'allowed_fields', or 'compliance_level' in body." });
        }

        let updateExpression = "SET updated_at = :now";
        const expressionAttributeValues: Record<string, any> = { ":now": new Date().toISOString(), ":sub": userSub };
        const expressionAttributeNames: Record<string, string> = {}; // Needed if using reserved words

        if (name !== undefined) {
            if (typeof name !== 'string' || name.trim().length === 0) {
                return createResponse(400, { error: "Bad Request: 'name' must be a non-empty string." });
            }
            updateExpression += ", #n = :name"; // Use placeholder for reserved word 'name'
            expressionAttributeNames["#n"] = "name";
            expressionAttributeValues[":name"] = name.trim();
        }
        if (domains !== undefined) {
            if (!Array.isArray(domains) || domains.length === 0) {
                 return createResponse(400, { error: "Bad Request: 'domains' must be a non-empty array." });
            }
            if (!domains.every(d => typeof d === 'string' && d.trim().length > 0)) {
                return createResponse(400, { error: "Bad Request: 'domains' must contain only non-empty strings." });
            }
            updateExpression += ", domains = :domains"; // Use direct attribute name if not reserved
            expressionAttributeValues[":domains"] = domains; // Store as native list
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
        if (allowed_fields !== undefined) {
            if (!Array.isArray(allowed_fields)) {
                return createResponse(400, { error: "Bad Request: 'allowed_fields' must be an array." });
            }
            if (!allowed_fields.every(f => typeof f === 'string')) {
                return createResponse(400, { error: "Bad Request: 'allowed_fields' must contain only strings." });
            }
            updateExpression += ", allowed_fields = :allowed_fields";
            expressionAttributeValues[":allowed_fields"] = allowed_fields; // Store as native list
        }
        if (compliance_level !== undefined) {
            const validComplianceLevels = ['yes', 'maybe', 'no'];
            if (typeof compliance_level !== 'string' || !validComplianceLevels.includes(compliance_level)) {
                return createResponse(400, { error: "Bad Request: 'compliance_level' must be either 'yes', 'maybe', or 'no'." });
            }
            // Only update if a valid value is provided
            updateExpression += ", compliance_level = :compliance_level";
            expressionAttributeValues[":compliance_level"] = compliance_level;
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