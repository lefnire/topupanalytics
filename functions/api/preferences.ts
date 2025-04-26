import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Helper function for standard responses
const createResponse = (statusCode: number, body: any) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  const claims = event.requestContext.authorizer?.jwt.claims;
  const userSub = claims?.sub as string | undefined;

  if (!userSub) {
    return createResponse(401, { error: "Unauthorized: Missing user identifier" });
  }

  const tableName = Resource.UserPreferencesTable.name;

  try {
    // --- Get User Preferences ---
    if (routeKey === "GET /api/user/preferences") {
      const getParams = new GetCommand({
        TableName: tableName,
        Key: { cognito_sub: userSub },
      });
      const { Item } = await docClient.send(getParams);
      if (!Item) {
        // Return default preferences if none exist? Or 404? Let's return defaults.
        return createResponse(200, { cognito_sub: userSub, theme: 'light', email_notifications: 'daily', plan_tier: 'free' });
      }
      return createResponse(200, Item);
    }

    // --- Update User Preferences ---
    if (routeKey === "PUT /api/user/preferences") {
      const body = event.body ? JSON.parse(event.body) : {};
      const { theme, email_notifications, plan_tier } = body; // Allow updating specific fields

      if (!theme && !email_notifications && !plan_tier) {
        return createResponse(400, { error: "Bad Request: Requires 'theme', 'email_notifications', or 'plan_tier' in body." });
      }

      let updateExpression = "SET updated_at = :now";
      const expressionAttributeValues: Record<string, any> = { ":now": new Date().toISOString() };
      const expressionAttributeNames: Record<string, string> = {}; // Needed if using reserved words

      if (theme) {
        updateExpression += ", #theme = :theme";
        expressionAttributeValues[":theme"] = theme;
        expressionAttributeNames["#theme"] = "theme";
      }
      if (email_notifications) {
        updateExpression += ", #email_notifications = :email_notifications";
        expressionAttributeValues[":email_notifications"] = email_notifications;
        expressionAttributeNames["#email_notifications"] = "email_notifications";
      }
       if (plan_tier) {
        updateExpression += ", #plan_tier = :plan_tier";
        expressionAttributeValues[":plan_tier"] = plan_tier;
        expressionAttributeNames["#plan_tier"] = "plan_tier";
      }

      const updateParams = new UpdateCommand({
        TableName: tableName,
        Key: { cognito_sub: userSub }, // Use userSub as the key
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ...(Object.keys(expressionAttributeNames).length > 0 && { ExpressionAttributeNames: expressionAttributeNames }),
        ReturnValues: "ALL_NEW",
      });

      const { Attributes } = await docClient.send(updateParams);
      return createResponse(200, Attributes);
    }

    // Fallback for unhandled routes
    return createResponse(404, { error: `Not Found: Route ${routeKey} not handled.` });

  } catch (error: any) {
    console.error("Error processing preferences request:", error);
    return createResponse(500, { error: "Internal Server Error", details: error.message });
  }
};