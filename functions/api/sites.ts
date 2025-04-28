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

// --- Validation Helper Functions ---

const validateName = (name: any): { value?: string; error?: string } => {
  if (name === undefined) return {}; // Not provided, valid for update
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: "Bad Request: 'name' must be a non-empty string." };
  }
  return { value: name.trim() };
};

const validateDomains = (domains: any): { value?: string[]; error?: string } => {
  if (domains === undefined) return {}; // Not provided, valid for update
  if (!Array.isArray(domains) || domains.length === 0) {
    return { error: "Bad Request: 'domains' must be a non-empty array." };
  }

  const validatedHostnames: string[] = [];
  for (const d of domains) {
    if (typeof d !== 'string' || d.trim().length === 0) {
      return { error: "Bad Request: 'domains' must contain only non-empty strings." };
    }
    const trimmedDomain = d.trim();
    try {
      // Attempt to parse as a full URL first
      // If it doesn't have a protocol, prepend one for the parser
      const urlString = trimmedDomain.includes('://') ? trimmedDomain : `http://${trimmedDomain}`;
      const parsedUrl = new URL(urlString);
      if (parsedUrl.hostname) {
        validatedHostnames.push(parsedUrl.hostname);
      } else {
        // This case should be rare if URL parsing succeeds but hostname is empty
        return { error: `Bad Request: Invalid domain format '${trimmedDomain}'. Could not extract hostname.` };
      }
    } catch (e) {
      // If URL parsing fails, treat it as an invalid domain format
      return { error: `Bad Request: Invalid domain format '${trimmedDomain}'. Use hostname (e.g., example.com) or full URL.` };
    }
  }

  // Deduplicate hostnames
  const uniqueHostnames = [...new Set(validatedHostnames)];

  return { value: uniqueHostnames };
};

const validateAllowedFields = (allowed_fields: any): { value?: string[]; error?: string } => {
    if (allowed_fields === undefined) return { value: [] }; // Default to empty array if not provided for update
    if (!Array.isArray(allowed_fields)) {
        return { error: "Bad Request: 'allowed_fields' must be an array." };
    }
    if (!allowed_fields.every(f => typeof f === 'string')) {
        return { error: "Bad Request: 'allowed_fields' must contain only strings." };
    }
    return { value: allowed_fields };
};

const validateComplianceLevel = (compliance_level: any): { value?: 'yes' | 'maybe' | 'no'; error?: string } => {
  const validLevels = ['yes', 'maybe', 'no'];
  if (compliance_level === undefined) return {}; // Not provided, valid for update, default handled elsewhere if needed
  if (typeof compliance_level !== 'string' || !validLevels.includes(compliance_level)) {
    return { error: "Bad Request: 'compliance_level' must be either 'yes', 'maybe', or 'no'." };
  }
  return { value: compliance_level as 'yes' | 'maybe' | 'no' };
};

// --- End Validation Helper Functions ---


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
      // Removed duplicate body declaration
      const { name: rawName, domains: rawDomains, allowed_fields: rawAllowedFields, compliance_level: rawComplianceLevel } = body;

      // --- Validation ---
      const nameValidation = validateName(rawName);
      if (nameValidation.error) return createResponse(400, { error: nameValidation.error });
      if (nameValidation.value === undefined) return createResponse(400, { error: "Bad Request: 'name' is required for creation." }); // Required for create

      const domainsValidation = validateDomains(rawDomains);
      if (domainsValidation.error) return createResponse(400, { error: domainsValidation.error });
      if (domainsValidation.value === undefined) return createResponse(400, { error: "Bad Request: 'domains' is required for creation." }); // Required for create

      const allowedFieldsValidation = validateAllowedFields(rawAllowedFields); // Defaults to [] if undefined
      if (allowedFieldsValidation.error) return createResponse(400, { error: allowedFieldsValidation.error });

      const complianceLevelValidation = validateComplianceLevel(rawComplianceLevel);
      if (complianceLevelValidation.error) return createResponse(400, { error: complianceLevelValidation.error });
      // --- End Validation ---

      const validatedName = nameValidation.value;
      const validatedDomains = domainsValidation.value;
      const validatedAllowedFields = allowedFieldsValidation.value!; // Not undefined due to default
      const validatedComplianceLevel = complianceLevelValidation.value; // Can be undefined

      const newSiteId = ulid();
     // Use the Site type for the item
     const itemToSave: Site = {
       site_id: newSiteId,
       owner_sub: userSub,
       name: validatedName, // Already trimmed
       domains: validatedDomains, // Already validated
       plan: 'free_tier', // Default plan
       request_allowance: 10000, // Default request allowance
       allowed_fields: validatedAllowedFields, // Already validated
       compliance_level: validatedComplianceLevel || 'maybe', // Default to 'maybe' if not provided
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
        const { name: rawName, domains: rawDomains, plan, allowed_fields: rawAllowedFields, compliance_level: rawComplianceLevel } = body;

        if (rawName === undefined && rawDomains === undefined && plan === undefined && rawAllowedFields === undefined && rawComplianceLevel === undefined) {
            return createResponse(400, { error: "Bad Request: At least one field ('name', 'domains', 'plan', 'allowed_fields', 'compliance_level') is required for update." });
        }

        let updateExpression = "SET updated_at = :now";
        const expressionAttributeValues: Record<string, any> = { ":now": new Date().toISOString(), ":sub": userSub };
        const expressionAttributeNames: Record<string, string> = {}; // Needed if using reserved words

        // Validate and add provided fields to the update expression
        if (rawName !== undefined) {
            const nameValidation = validateName(rawName);
            if (nameValidation.error) return createResponse(400, { error: nameValidation.error });
            updateExpression += ", #n = :name";
            expressionAttributeNames["#n"] = "name";
            expressionAttributeValues[":name"] = nameValidation.value;
        }
        if (rawDomains !== undefined) {
            const domainsValidation = validateDomains(rawDomains);
            if (domainsValidation.error) return createResponse(400, { error: domainsValidation.error });
            updateExpression += ", domains = :domains";
            expressionAttributeValues[":domains"] = domainsValidation.value;
        }
        if (plan !== undefined) {
            // Keep existing plan validation logic
            if (!useStripe && plan !== 'free_tier') {
                console.warn(`Attempted to set plan to '${plan}' for site ${siteId} while USE_STRIPE=false. Only 'free_tier' is allowed.`);
                return createResponse(400, { error: "Bad Request: Plan can only be set to 'free_tier' when Stripe integration is disabled." });
            }
            updateExpression += ", plan = :plan";
            expressionAttributeValues[":plan"] = plan;
        }
        if (rawAllowedFields !== undefined) {
            const allowedFieldsValidation = validateAllowedFields(rawAllowedFields);
            if (allowedFieldsValidation.error) return createResponse(400, { error: allowedFieldsValidation.error });
            updateExpression += ", allowed_fields = :allowed_fields";
            expressionAttributeValues[":allowed_fields"] = allowedFieldsValidation.value;
        }
        if (rawComplianceLevel !== undefined) {
            const complianceLevelValidation = validateComplianceLevel(rawComplianceLevel);
            if (complianceLevelValidation.error) return createResponse(400, { error: complianceLevelValidation.error });
            updateExpression += ", compliance_level = :compliance_level";
            expressionAttributeValues[":compliance_level"] = complianceLevelValidation.value;
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