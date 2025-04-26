import { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import Stripe from 'stripe';
// import { Resource } from "sst"; // Using process.env instead for linked resources
import * as process from 'process'; // Import process for env vars

// Initialize DynamoDB Client
const ddbClient = new DynamoDBClient({});

// Initialize Stripe Client
// SST automatically injects linked resource values into environment variables
// Format: SST_<ResourceType>_<propertyName>_<ResourceName>
const stripeSecretKeyValue = process.env.SST_Secret_value_StripeSecretKey;
if (!stripeSecretKeyValue) {
    throw new Error("Stripe secret key (SST_Secret_value_StripeSecretKey) is not configured in environment.");
}
const stripe = new Stripe(stripeSecretKeyValue, {
  apiVersion: '2025-03-31.basil', // Updated based on TS error
});

const SITES_TABLE_NAME = process.env.SST_Table_tableName_SitesTable;
const USER_PREFERENCES_TABLE_NAME = process.env.SST_Table_tableName_UserPreferencesTable;

if (!SITES_TABLE_NAME || !USER_PREFERENCES_TABLE_NAME) {
    throw new Error("DynamoDB table names (SitesTable or UserPreferencesTable) are not configured in environment.");
}

const PLAN_INDEX_NAME = "planIndex"; // GSI name defined in sst.config.ts
const TOPUP_AMOUNT_CENTS = 500; // $5.00
const TOPUP_ALLOWANCE_INCREASE = 500000;

interface Site {
  site_id: string;
  owner_sub: string;
  plan: string;
  request_allowance: number;
  // other fields...
}

interface UserPreferences {
  cognito_sub: string;
  stripe_customer_id?: string;
  stripe_payment_method_id?: string;
  is_payment_active?: number;
  // other fields...
}

export const handler = async (event: any): Promise<void> => {
  console.log("Starting chargeProcessor execution...");

  try {
    // 1. Identify Sites to Charge using the GSI
    const queryParams = {
      TableName: SITES_TABLE_NAME,
      IndexName: PLAN_INDEX_NAME,
      KeyConditionExpression: "#plan = :planVal",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: marshall({ ":planVal": "needs_payment" }),
      // Add ProjectionExpression if needed to fetch only required attributes
    };

    const queryResult = await ddbClient.send(new QueryCommand(queryParams));
    const sitesToCharge = (queryResult.Items || []).map(item => unmarshall(item)) as Site[];

    console.log(`Found ${sitesToCharge.length} sites potentially needing payment.`);

    if (sitesToCharge.length === 0) {
      console.log("No sites require charging at this time.");
      return;
    }

    // 2. Process each site
    for (const site of sitesToCharge) {
      console.log(`Processing site: ${site.site_id}, owner: ${site.owner_sub}`);

      try {
        // 3. Fetch User Preferences
        const getPrefParams = {
          TableName: USER_PREFERENCES_TABLE_NAME,
          Key: marshall({ cognito_sub: site.owner_sub }),
        };
        const prefResult = await ddbClient.send(new GetItemCommand(getPrefParams));
        const userPreferences = prefResult.Item ? unmarshall(prefResult.Item) as UserPreferences : null;

        // 4. Check Payment Readiness
        if (
          !userPreferences ||
          userPreferences.is_payment_active !== 1 ||
          !userPreferences.stripe_customer_id ||
          !userPreferences.stripe_payment_method_id
        ) {
          console.warn(`Site ${site.site_id}: User ${site.owner_sub} has no active payment method. Skipping charge. Consider setting plan to 'payment_failed'.`);
          // Optionally update site plan here if desired
          // await updateSitePlan(site.site_id, 'payment_failed');
          continue; // Skip to the next site
        }

        console.log(`Site ${site.site_id}: Found active payment method for user ${site.owner_sub}. Attempting charge.`);

        // 5. Attempt Stripe Charge (Off-Session)
        let paymentIntent: Stripe.PaymentIntent | null = null;
        try {
          paymentIntent = await stripe.paymentIntents.create({
            amount: TOPUP_AMOUNT_CENTS,
            currency: 'usd',
            customer: userPreferences.stripe_customer_id,
            payment_method: userPreferences.stripe_payment_method_id,
            off_session: true,
            confirm: true,
            description: `Top-up for site ${site.site_id} - ${TOPUP_ALLOWANCE_INCREASE.toLocaleString()} requests`,
            error_on_requires_action: true, // Fail immediately if action is needed
            // metadata: { site_id: site.site_id, owner_sub: site.owner_sub } // Optional metadata
          });

          console.log(`Site ${site.site_id}: PaymentIntent created with status: ${paymentIntent.status}`);

          // 6. Handle Charge Success
          if (paymentIntent.status === 'succeeded') {
            console.log(`Site ${site.site_id}: Charge successful! Updating allowance and plan.`);
            await updateSiteOnSuccess(site.site_id);
            console.log(`Site ${site.site_id}: Allowance and plan updated successfully.`);
          } else {
            // This case might occur if error_on_requires_action=false, but good to handle defensively
            console.error(`Site ${site.site_id}: PaymentIntent status is ${paymentIntent.status}, not 'succeeded'. Treating as failure.`);
            await handleChargeFailure(site.site_id, userPreferences, `Unexpected PaymentIntent status: ${paymentIntent.status}`);
          }

        } catch (error: any) {
          // 7. Handle Charge Failure
          console.error(`Site ${site.site_id}: Stripe charge failed for user ${site.owner_sub}. Error: ${error.message}`);
          await handleChargeFailure(site.site_id, userPreferences, error);
        }

      } catch (innerError: any) {
        console.error(`Site ${site.site_id}: Error processing site (fetching prefs or updating DB): ${innerError.message}`, innerError);
        // Decide if site plan should be updated even on non-Stripe errors
      }
    } // End site loop

  } catch (error: any) {
    console.error("Fatal error during chargeProcessor execution:", error);
    // Consider sending a notification (e.g., SNS) on fatal errors
  } finally {
    console.log("chargeProcessor execution finished.");
  }
};

// --- Helper Functions ---

async function updateSiteOnSuccess(siteId: string): Promise<void> {
  const updateParams = {
    TableName: SITES_TABLE_NAME,
    Key: marshall({ site_id: siteId }),
    UpdateExpression: "SET #plan = :newPlan ADD #allowance :increase",
    ExpressionAttributeNames: {
      "#plan": "plan",
      "#allowance": "request_allowance",
    },
    ExpressionAttributeValues: marshall({
      ":newPlan": "active_paid",
      ":increase": TOPUP_ALLOWANCE_INCREASE,
    }),
    // Optional: Add ConditionExpression to ensure the plan was 'needs_payment'
    // ConditionExpression: "#plan = :expectedPlan",
    // ExpressionAttributeValues: marshall({ /* ... */ ":expectedPlan": "needs_payment" }),
  };
  await ddbClient.send(new UpdateItemCommand(updateParams));
}

async function handleChargeFailure(siteId: string, userPrefs: UserPreferences, error: any): Promise<void> {
  let isPaymentMethodIssue = false;
  let errorMessage = "Unknown Stripe Error";

  if (error instanceof Stripe.errors.StripeCardError) {
    // Card declined, expired, insufficient funds, etc.
    isPaymentMethodIssue = true;
    errorMessage = `Stripe Card Error: ${error.message} (Code: ${error.code})`;
  } else if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    // Invalid parameters, potentially including non-existent customer or payment method
    // Check if the error message indicates a payment method problem
    if (error.message.toLowerCase().includes('paymentmethod') || error.message.toLowerCase().includes('customer')) {
        isPaymentMethodIssue = true;
    }
    errorMessage = `Stripe Invalid Request Error: ${error.message}`;
  } else if (error instanceof Stripe.errors.StripeError) {
    // Other Stripe API errors (rate limits, connection issues, etc.)
    errorMessage = `Stripe API Error: ${error.message} (Type: ${error.type})`;
    // These might be temporary, so we might not want to disable the payment method immediately
  } else if (typeof error === 'string') {
      // Handle the case where a string message was passed (e.g., unexpected status)
      errorMessage = error;
      // Assume it might be a payment issue if it's an unexpected status after attempt
      isPaymentMethodIssue = true;
  }
   else {
    errorMessage = `Non-Stripe Error: ${error.message || 'Unknown error object'}`;
  }

  console.log(`Site ${siteId}: Handling charge failure. Payment Method Issue: ${isPaymentMethodIssue}. Message: ${errorMessage}`);

  // Update site plan to 'payment_failed' regardless of the error type for now
  await updateSitePlan(siteId, 'payment_failed');

  // If it's identified as a payment method issue, deactivate it in user preferences
  if (isPaymentMethodIssue && userPrefs.cognito_sub) {
    await deactivateUserPaymentMethod(userPrefs.cognito_sub);
  }
}

async function updateSitePlan(siteId: string, newPlan: string): Promise<void> {
  try {
    const updateParams = {
      TableName: SITES_TABLE_NAME,
      Key: marshall({ site_id: siteId }),
      UpdateExpression: "SET #plan = :newPlan",
      ExpressionAttributeNames: { "#plan": "plan" },
      ExpressionAttributeValues: marshall({ ":newPlan": newPlan }),
    };
    await ddbClient.send(new UpdateItemCommand(updateParams));
    console.log(`Site ${siteId}: Plan updated to ${newPlan}.`);
  } catch (dbError: any) {
    console.error(`Site ${siteId}: Failed to update plan to ${newPlan}. Error: ${dbError.message}`);
  }
}

async function deactivateUserPaymentMethod(cognitoSub: string): Promise<void> {
  try {
    const updateParams = {
      TableName: USER_PREFERENCES_TABLE_NAME,
      Key: marshall({ cognito_sub: cognitoSub }),
      UpdateExpression: "SET #isActive = :inactiveValue",
      ExpressionAttributeNames: { "#isActive": "is_payment_active" },
      ExpressionAttributeValues: marshall({ ":inactiveValue": 0 }),
      // Optional: Add ConditionExpression to ensure the payment method was active
      // ConditionExpression: "#isActive = :expectedActive",
      // ExpressionAttributeValues: marshall({ /* ... */ ":expectedActive": 1 }),
    };
    await ddbClient.send(new UpdateItemCommand(updateParams));
    console.log(`User ${cognitoSub}: Payment method deactivated due to charge failure.`);
  } catch (dbError: any) {
    console.error(`User ${cognitoSub}: Failed to deactivate payment method. Error: ${dbError.message}`);
  }
}