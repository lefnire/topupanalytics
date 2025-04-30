import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { eq } from "drizzle-orm";
import { db } from "../../shared/db/client";
import { accounts } from "../../shared/db/schema";

// Helper function for standard responses
const createResponse = (statusCode: number, body: any) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// GET /api/accounts - Fetches user account details
export const get: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer?.jwt.claims;
  const userSub = claims?.sub as string | undefined;

  if (!userSub) {
    console.error("User identifier (sub) is missing from authorizer claims.");
    return createResponse(401, { error: "Unauthorized: Missing user identifier" });
  }

  try {
    const result = await db.select({
      cognitoSub: accounts.cognitoSub,
      emailNotifications: accounts.emailNotifications,
      createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt,
    }).from(accounts).where(eq(accounts.cognitoSub, userSub));

    let account = result[0];

    if (!account) {
      // Insert default account if none exists
      console.log(`No account found for ${userSub}, creating default.`);
      const insertResult = await db.insert(accounts).values({
        cognitoSub: userSub,
        emailNotifications: 'daily', // Default value
      }).returning({
        cognitoSub: accounts.cognitoSub,
        emailNotifications: accounts.emailNotifications,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
      });
      account = insertResult[0];
      console.log(`Default account created for ${userSub}:`, account);
      // Return 201 Created for new resource
      return createResponse(201, account);
    }

    return createResponse(200, account);

  } catch (error: any) {
    console.error("Error fetching account:", error);
    return createResponse(500, { error: "Internal Server Error", details: error.message });
  }
};

// PUT /api/accounts - Updates user account details
export const update: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer?.jwt.claims;
  const userSub = claims?.sub as string | undefined;

  if (!userSub) {
    console.error("User identifier (sub) is missing from authorizer claims.");
    return createResponse(401, { error: "Unauthorized: Missing user identifier" });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (parseError: any) {
    return createResponse(400, { error: "Bad Request: Invalid JSON body", details: parseError.message });
  }

  // Validate input - only email_notifications is updatable here
  if (body.email_notifications === undefined) {
    return createResponse(400, { error: "Bad Request: Missing 'email_notifications' field in body." });
  }

  // Basic validation for email_notifications value (can be expanded)
  const allowedNotificationValues = ['daily', 'weekly', 'never']; // Example allowed values
  if (!allowedNotificationValues.includes(body.email_notifications)) {
     return createResponse(400, { error: `Bad Request: Invalid 'email_notifications' value. Allowed values: ${allowedNotificationValues.join(', ')}.` });
  }

  try {
    const updateResult = await db.update(accounts)
      .set({
        emailNotifications: body.email_notifications,
        updatedAt: new Date(), // Update timestamp
      })
      .where(eq(accounts.cognitoSub, userSub))
      .returning({
        cognitoSub: accounts.cognitoSub,
        emailNotifications: accounts.emailNotifications,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
      });

    if (updateResult.length === 0) {
      // This could mean the user record didn't exist to update.
      // Depending on requirements, could try an insert here (upsert) or return 404.
      // For now, let's return 404 as the GET should have created it if needed.
      console.warn(`Attempted to update non-existent account for ${userSub}`);
      return createResponse(404, { error: "Not Found: Account not found for update." });
    }

    return createResponse(200, updateResult[0]);

  } catch (error: any) {
    console.error("Error updating account:", error);
    return createResponse(500, { error: "Internal Server Error", details: error.message });
  }
};