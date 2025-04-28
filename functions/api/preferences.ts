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
  const useStripe = process.env.USE_STRIPE === 'true';
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  // Log the entire authorizer context for debugging
  // console.log("Authorizer Context:", JSON.stringify(event.requestContext.authorizer, null, 2));

  const claims = event.requestContext.authorizer?.jwt.claims;
  const userSub = claims?.sub as string | undefined;

  // console.log("Extracted Claims:", JSON.stringify(claims, null, 2));
  // console.log("Extracted userSub:", userSub);

  if (!userSub) {
    console.error("User identifier (sub) is missing from authorizer claims.");
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
        return createResponse(200, { cognito_sub: userSub, theme: 'light', email_notifications: 'daily' }); // Removed plan_tier default, not managed here
      }
      // If Stripe is disabled, remove Stripe-specific fields before returning
      if (!useStripe) {
          delete Item.stripe_customer_id;
          delete Item.stripe_payment_method_id;
          delete Item.stripe_last4;
          delete Item.is_payment_active;
      }
      return createResponse(200, Item);
    }

    // --- Update User Preferences ---
    if (routeKey === "PUT /api/user/preferences") {
      const body = event.body ? JSON.parse(event.body) : {};
      // Define allowed non-Stripe fields for update
      const allowedUpdateFields = ['theme', 'email_notifications'];
      const stripeFields = ['stripe_customer_id', 'stripe_payment_method_id', 'stripe_last4', 'is_payment_active'];

      // Check if any fields are provided for update
      const providedFields = Object.keys(body).filter(key => allowedUpdateFields.includes(key));
      if (providedFields.length === 0) {
          return createResponse(400, { error: `Bad Request: Requires one of the following fields in body: ${allowedUpdateFields.join(', ')}.` });
      }

      // If Stripe is disabled, explicitly reject updates containing Stripe fields
      if (!useStripe) {
          const providedStripeFields = Object.keys(body).filter(key => stripeFields.includes(key));
          if (providedStripeFields.length > 0) {
              console.warn(`User ${userSub} attempted to update Stripe fields (${providedStripeFields.join(', ')}) while USE_STRIPE=false.`);
              return createResponse(400, { error: `Bad Request: Cannot update Stripe-related fields (${providedStripeFields.join(', ')}) when Stripe integration is disabled.` });
          }
      }

      // Build update expression only for allowed fields provided in the body
      let updateExpression = "SET updated_at = :now";
      const expressionAttributeValues: Record<string, any> = { ":now": new Date().toISOString() };
      const expressionAttributeNames: Record<string, string> = {};

      // Add only the allowed fields that are present in the body to the update expression
      if (body.theme !== undefined) {
          updateExpression += ", #theme = :theme";
          expressionAttributeValues[":theme"] = body.theme;
          expressionAttributeNames["#theme"] = "theme";
      }
      if (body.email_notifications !== undefined) {
          updateExpression += ", #email_notifications = :email_notifications";
          expressionAttributeValues[":email_notifications"] = body.email_notifications;
          expressionAttributeNames["#email_notifications"] = "email_notifications";
      }
      // NOTE: plan_tier and Stripe fields are intentionally not updatable via this endpoint

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