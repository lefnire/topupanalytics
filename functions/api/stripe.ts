import { APIGatewayProxyHandlerV2, APIGatewayProxyEventV2 } from "aws-lambda";
import { Config } from "sst/node/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from 'stripe';
import { Table } from "sst/node/table";

// Initialize Stripe with the secret key from SST Config
const stripe = new Stripe(Config.STRIPE_SECRET_KEY, {
  apiVersion: '2025-03-31.basil', // Match expected version from TS error
});

// Initialize DynamoDB Document Client
const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

// Helper function for standard responses
const createResponse = (statusCode: number, body: any) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    // Add CORS headers if needed, though API Gateway CORS config should handle most cases
    "Access-Control-Allow-Origin": "*", // Adjust in production
    "Access-Control-Allow-Credentials": true,
  },
  body: JSON.stringify(body),
});

// Define placeholder Price ID (replace with your actual Stripe Price ID)
const PREMIUM_PLAN_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID || 'price_placeholder_premium'; // Use env var or fallback

// Type assertion helper for JWT claims
interface CustomEvent extends APIGatewayProxyEventV2 {
  requestContext: APIGatewayProxyEventV2["requestContext"] & {
    authorizer?: {
      jwt: {
        claims: {
          sub: string;
          email?: string; // Assuming email is included in claims
        };
      };
    };
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event: APIGatewayProxyEventV2) => {
  const useStripe = process.env.USE_STRIPE === 'true';

  // Safeguard: If Stripe is disabled via env var, this function should not be invoked.
  // Return an error if it somehow is.
  if (!useStripe) {
    console.error("Stripe API handler invoked when USE_STRIPE is false. This should not happen.");
    return createResponse(501, { error: "Stripe functionality is not enabled." });
  }

  const routeKey = event.routeKey;
  const rawBody = event.body; // Needed for webhook verification

  console.log(`Stripe handler invoked for route: ${routeKey}`);

  try {
    // --- Stripe Webhook Handler ---
    if (routeKey === "POST /api/stripe/webhook") {
      const signature = event.headers['stripe-signature'];

      if (!signature) {
        console.error("Webhook Error: Missing stripe-signature header");
        return createResponse(400, { error: "Missing stripe-signature header" });
      }
      if (!rawBody) {
        console.error("Webhook Error: Missing request body");
        return createResponse(400, { error: "Missing request body" });
      }

      let stripeEvent: Stripe.Event;
      try {
        stripeEvent = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          Config.STRIPE_WEBHOOK_SECRET // Use the webhook secret from SST Config
        );
        console.log(`Webhook event received: ${stripeEvent.type}`);
      } catch (err: any) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return createResponse(400, { error: `Webhook Error: ${err.message}` });
      }

      // Handle the event
      switch (stripeEvent.type) {
        // REMOVED: checkout.session.completed handling for subscriptions

        case 'setup_intent.succeeded':
          const setupIntent = stripeEvent.data.object as Stripe.SetupIntent;
          console.log(`SetupIntent succeeded: ${setupIntent.id}`);

          const paymentMethodId = setupIntent.payment_method as string;
          const siCustomerId = setupIntent.customer as string;
          const userSubFromMetadata = setupIntent.metadata?.user_sub; // Retrieve from metadata

          if (!paymentMethodId || !siCustomerId || !userSubFromMetadata) {
            console.error("Webhook Error: Missing payment_method, customer, or user_sub in SetupIntent metadata", {
              setupIntentId: setupIntent.id,
              paymentMethodId,
              siCustomerId,
              userSubFromMetadata,
            });
            break; // Don't proceed if essential info is missing
          }

          try {
            // Retrieve PaymentMethod details to get last4
            const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
            const last4 = paymentMethod.card?.last4;

            if (!last4) {
              console.warn(`Could not retrieve last4 for PaymentMethod: ${paymentMethodId}`);
              // Proceed without last4 if necessary, or handle as an error
            }

            // Update UserPreferencesTable
            const updateParams = {
              TableName: Table.UserPreferencesTable.tableName,
              Key: { cognito_sub: userSubFromMetadata },
              UpdateExpression: "set stripe_payment_method_id = :pmId, stripe_last4 = :last4, is_payment_active = :active",
              ExpressionAttributeValues: {
                ":pmId": paymentMethodId,
                ":last4": last4 || null, // Store null if not found
                ":active": 1, // Set payment as active
              },
              ConditionExpression: "attribute_exists(cognito_sub)", // Ensure user exists
            };
            await ddbDocClient.send(new UpdateCommand(updateParams));
            console.log(`User ${userSubFromMetadata} preferences updated with PaymentMethod ${paymentMethodId} (Last4: ${last4}), payment active.`);

          } catch (err: any) {
            console.error(`Error processing setup_intent.succeeded for ${setupIntent.id}:`, err);
            // Log error but still return 200 to Stripe
          }
          break;

        case 'setup_intent.setup_failed':
          const failedSetupIntent = stripeEvent.data.object as Stripe.SetupIntent;
          console.error(`SetupIntent failed: ${failedSetupIntent.id}`, {
            reason: failedSetupIntent.last_setup_error?.message,
            customerId: failedSetupIntent.customer,
            metadata: failedSetupIntent.metadata,
          });
          // Optionally, update user status or notify user
          break;

        case 'payment_method.detached':
          const detachedPaymentMethod = stripeEvent.data.object as Stripe.PaymentMethod;
          const pmCustomerId = detachedPaymentMethod.customer as string;
          console.log(`PaymentMethod detached: ${detachedPaymentMethod.id} for customer ${pmCustomerId}`);

          if (!pmCustomerId) {
            console.warn("PaymentMethod detached event missing customer ID.");
            break;
          }

          // Find user by Stripe Customer ID (Requires GSI or query)
          // Assuming a GSI 'stripeCustomerIdIndex' exists on UserPreferencesTable
          // TODO: Add GSI 'stripeCustomerIdIndex' to UserPreferencesTable in sst.config.ts
          try {
             // Query UserPreferencesTable by stripe_customer_id
             // NOTE: This requires a GSI on stripe_customer_id. Add this to sst.config.ts if not present.
             // Example GSI definition in sst.config.ts:
             // globalIndexes: {
             //   stripeCustomerIdIndex: { hashKey: "stripe_customer_id", projection: "all" },
             // },
             const queryParams = {
                TableName: Table.UserPreferencesTable.tableName,
                IndexName: "stripeCustomerIdIndex", // ASSUMED GSI NAME
                KeyConditionExpression: "stripe_customer_id = :customerId",
                ExpressionAttributeValues: { ":customerId": pmCustomerId },
             };
             const { Items } = await ddbDocClient.send(new QueryCommand(queryParams));

             if (Items && Items.length > 0) {
                const userToUpdate = Items[0];
                const userSubToUpdate = userToUpdate.cognito_sub;

                // Update UserPreferencesTable to deactivate payment
                const updateParams = {
                  TableName: Table.UserPreferencesTable.tableName,
                  Key: { cognito_sub: userSubToUpdate },
                  UpdateExpression: "set is_payment_active = :active, stripe_payment_method_id = :nullVal, stripe_last4 = :nullVal",
                  ExpressionAttributeValues: {
                    ":active": 0, // Set payment inactive
                    ":nullVal": null, // Clear PM details
                  },
                  ConditionExpression: "stripe_customer_id = :customerId", // Ensure we're updating the correct user
                };
                await ddbDocClient.send(new UpdateCommand(updateParams));
                console.log(`User ${userSubToUpdate} payment method deactivated due to detachment of PM ${detachedPaymentMethod.id}.`);
             } else {
                console.warn(`No user found for Stripe Customer ID: ${pmCustomerId} during payment_method.detached event.`);
             }
          } catch (dbError: any) {
             console.error(`Failed to query/update user preferences for customer ${pmCustomerId} during payment_method.detached:`, dbError);
             // Log error but still return 200 to Stripe
          }
          break;

        // REMOVED: customer.subscription.* handling

        default:
          console.log(`Unhandled event type ${stripeEvent.type}`);
      }

      // Return a 200 response to acknowledge receipt of the event
      return createResponse(200, { received: true });
    }

    // --- Stripe Checkout Handler ---
    if (routeKey === "POST /api/stripe/checkout") {
      const typedEvent = event as CustomEvent; // Use type assertion
      const claims = typedEvent.requestContext.authorizer?.jwt.claims;
      const userSub = claims?.sub;
      const userEmail = claims?.email; // Assuming email is in claims

      if (!userSub) {
        return createResponse(401, { error: "Unauthorized: Missing user identifier" });
      }
      if (!userEmail) {
        // If email isn't in claims, you might need another way to get it (e.g., lookup in Cognito or user table)
        console.warn("User email not found in JWT claims. Required for Stripe Customer creation.");
        // return createResponse(400, { error: "User email not available for checkout" });
        // For now, proceed without email if necessary, but Stripe Customer creation might fail or be less useful
      }

      console.log(`Checkout initiated for user: ${userSub}`);

      // Parse request body for checkout details
      let requestBody: { siteId?: string; successUrl?: string; cancelUrl?: string; } = {};
      if (rawBody) {
        try {
          requestBody = JSON.parse(rawBody);
        } catch (parseError) {
          console.error("Failed to parse request body:", parseError);
          return createResponse(400, { error: "Invalid request body" });
        }
      }

      const { siteId, successUrl, cancelUrl } = requestBody;

      if (!siteId) {
        return createResponse(400, { error: "Missing 'siteId' in request body" });
      }
      if (!successUrl || !cancelUrl) {
        return createResponse(400, { error: "Missing 'successUrl' or 'cancelUrl' in request body" });
      }

      // 1. Find or Create Stripe Customer
      let customerId: string | undefined;

      // Check UserPreferencesTable for existing customer ID
      try {
        const getParams = {
          TableName: Table.UserPreferencesTable.tableName,
          Key: { cognito_sub: userSub },
        };
        const { Item } = await ddbDocClient.send(new GetCommand(getParams));
        customerId = Item?.stripe_customer_id;

        if (!customerId && userEmail) {
          console.log(`No Stripe customer found for ${userSub}, creating new one...`);
          const customer = await stripe.customers.create({
            email: userEmail,
            metadata: { cognito_sub: userSub },
          });
          customerId = customer.id;
          console.log(`Created Stripe customer ${customerId} for ${userSub}`);

          // Store the new customer ID back in DynamoDB
          const updateParams = {
            TableName: Table.UserPreferencesTable.tableName,
            Key: { cognito_sub: userSub },
            UpdateExpression: "set stripe_customer_id = :customerId",
            ExpressionAttributeValues: { ":customerId": customerId },
          };
          await ddbDocClient.send(new UpdateCommand(updateParams));
          console.log(`Stored Stripe customer ID ${customerId} for user ${userSub}`);
        } else if (!customerId && !userEmail) {
            console.error(`Cannot create Stripe customer for ${userSub} without an email address.`);
            return createResponse(400, { error: "Cannot create Stripe customer without user email." });
        } else {
             console.log(`Found existing Stripe customer ${customerId} for user ${userSub}`);
        }

      } catch (dbError: any) {
        console.error("Error accessing UserPreferencesTable:", dbError);
        return createResponse(500, { error: "Database error checking for Stripe customer" });
      }

      // 2. Create Stripe Checkout Session
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          customer: customerId, // Associate with the Stripe Customer ID
          mode: 'setup', // Changed mode to 'setup'
          success_url: successUrl, // Use URL from request body
          cancel_url: cancelUrl,   // Use URL from request body
          setup_intent_data: { // Added setup_intent_data
            metadata: {
              // Include relevant IDs for webhook processing
              customer_id: customerId, // Link SetupIntent to Stripe Customer
              user_sub: userSub,       // Link SetupIntent to Cognito User Sub
              // site_id: siteId, // siteId is not directly needed for setup intent, but could be added if required later
            }
          },
          // line_items removed for setup mode
          metadata: {
            // Metadata on the session itself (optional, but can be useful for context)
            user_sub: userSub,
            // site_id: siteId, // Keep if needed for success/cancel page context
          },
        });

        console.log(`Created setup checkout session: ${session.id}`);
        // Return the session ID to the frontend
        return createResponse(200, { sessionId: session.id });

      } catch (stripeError: any) {
        console.error("Error creating Stripe Checkout session:", stripeError);
        return createResponse(500, { error: "Failed to create checkout session", details: stripeError.message });
      }
    }

    // Fallback for unhandled routes within this handler
    return createResponse(404, { error: `Not Found: Route ${routeKey} not handled by Stripe handler.` });

  } catch (error: any) {
    console.error("Error processing Stripe request:", error);
    return createResponse(500, { error: "Internal Server Error", details: error.message });
  }
};