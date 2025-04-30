import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { db } from "../../shared/db/client"; // Import Drizzle client
import { sites } from "../../shared/db/schema"; // Import sites schema
import { eq, and } from "drizzle-orm"; // Import Drizzle functions
import { ulid } from "ulid"; // For generating unique site IDs
import { z } from 'zod'; // For input validation

// --- Zod Schemas for Validation ---

const ComplianceLevelEnum = z.enum(['yes', 'maybe', 'no']).optional();
const ComplianceLevelSchema = z.union([
  z.literal('yes'),
  z.literal('maybe'),
  z.literal('no'),
  z.undefined(), // Allow undefined for updates
]);

const BaseSiteSchema = z.object({
  name: z.string().trim().min(1, "Name cannot be empty."),
  domains: z.array(z.string().trim().min(1))
    .min(1, "At least one domain is required.")
    .transform(domains => {
      const hostnames = domains.map(d => {
        try {
          const urlString = d.includes('://') ? d : `http://${d}`;
          const parsedUrl = new URL(urlString);
          return parsedUrl.hostname;
        } catch (e) {
          throw new z.ZodError([{
            code: z.ZodIssueCode.custom,
            path: ['domains'],
            message: `Invalid domain format '${d}'. Use hostname (e.g., example.com) or full URL.`,
          }]);
        }
      }).filter(Boolean); // Filter out potential null/empty hostnames
      return [...new Set(hostnames)]; // Deduplicate
    }),
  // allowed_fields: z.array(z.string()).optional().default([]), // Removed: Not in schema
  compliance_level: ComplianceLevelSchema,
});

// name and domains are required for creation. compliance_level is optional (defaults in DB/mapper).
const CreateSiteSchema = BaseSiteSchema.required({ name: true, domains: true });

// At least one field must be provided for update.
const UpdateSiteSchema = BaseSiteSchema.partial().refine(
  data => Object.keys(data).length > 0,
  "At least one field ('name', 'domains', 'compliance_level') is required for update."
);

// --- Helper Functions ---

const createResponse = (statusCode: number, body: any) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Map schema integer to API string representation
const mapComplianceLevelToString = (level: number | null | undefined): 'yes' | 'maybe' | 'no' | undefined => {
  if (level === 2) return 'yes';
  if (level === 1) return 'maybe';
  if (level === 0) return 'no';
  return undefined; // Or 'maybe' if a default is desired for null/undefined in DB
};

// Map API string to schema integer representation (0=no, 1=maybe, 2=yes)
const mapComplianceLevelToInteger = (level: 'yes' | 'maybe' | 'no' | undefined): 0 | 1 | 2 => {
  if (level === 'yes') return 2;
  if (level === 'no') return 0;
  return 1; // Default to 'maybe' (1) if undefined or 'maybe'
};

// Transform DB result to API response format (e.g., map compliance level)
const transformSiteForApi = (site: typeof sites.$inferSelect) => {
  return {
    ...site,
    compliance_level: mapComplianceLevelToString(site.complianceLevel),
    // Convert Date objects to ISO strings if not already handled
    created_at: site.createdAt instanceof Date ? site.createdAt.toISOString() : site.createdAt,
    updated_at: site.updatedAt instanceof Date ? site.updatedAt.toISOString() : site.updatedAt,
  };
};


// --- API Handler ---

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  const claims = event.requestContext.authorizer?.jwt.claims;
  const userSub = claims?.sub as string | undefined;

  if (!userSub) {
    return createResponse(401, { error: "Unauthorized: Missing user identifier" });
  }

  const siteId = event.pathParameters?.site_id;

  try {
    const body = event.body ? JSON.parse(event.body) : {};

    // --- Site Creation ---
    if (routeKey === "POST /api/sites") {
      const validationResult = CreateSiteSchema.safeParse(body);
      if (!validationResult.success) {
        return createResponse(400, { error: "Bad Request", details: validationResult.error.flatten().fieldErrors });
      }
      // const { name, domains, allowed_fields, compliance_level } = validationResult.data; // Old
      const { name, domains, compliance_level } = validationResult.data; // Corrected: removed allowed_fields

      const newSiteId = ulid();
      const now = new Date();

      const newSiteData = {
        siteId: newSiteId,
        ownerSub: userSub,
        name: name,
        domains: domains,
        plan: 'free_tier', // Default plan
        requestAllowance: 10000, // Default request allowance
        // allowedFields: allowed_fields, // Removed: Not in schema
        complianceLevel: mapComplianceLevelToInteger(compliance_level), // Map to integer (0, 1, or 2)
        createdAt: now,
        updatedAt: now,
      };

      const insertedSites = await db.insert(sites)
        .values(newSiteData)
        .returning();

      if (insertedSites.length === 0) {
         throw new Error("Failed to create site record."); // Should not happen if insert is successful
      }

      return createResponse(201, transformSiteForApi(insertedSites[0]));
    }

    // --- List Sites ---
    if (routeKey === "GET /api/sites") {
      const userSites = await db.select()
        .from(sites)
        .where(eq(sites.ownerSub, userSub));

      return createResponse(200, userSites.map(transformSiteForApi));
    }

    // --- Site Specific Operations (require siteId) ---
    if (!siteId) {
       return createResponse(400, { error: "Bad Request: Missing site_id parameter" });
    }

    // --- Get Site Details ---
    if (routeKey === "GET /api/sites/{site_id}") {
      const foundSites = await db.select()
        .from(sites)
        .where(and(eq(sites.siteId, siteId), eq(sites.ownerSub, userSub)));

      if (foundSites.length === 0) {
        return createResponse(404, { error: "Site not found or access denied" });
      }

      return createResponse(200, transformSiteForApi(foundSites[0]));
    }

    // --- Update Site ---
    if (routeKey === "PUT /api/sites/{site_id}") {
        const validationResult = UpdateSiteSchema.safeParse(body);
        if (!validationResult.success) {
            return createResponse(400, { error: "Bad Request", details: validationResult.error.flatten().fieldErrors });
        }
        const updateDataInput = validationResult.data;

        // Build the object for Drizzle's set method, only including provided fields
        const updateData: Partial<typeof sites.$inferInsert> = {
            updatedAt: new Date(), // Always update timestamp
        };
        if (updateDataInput.name !== undefined) updateData.name = updateDataInput.name;
        if (updateDataInput.domains !== undefined) updateData.domains = updateDataInput.domains;
        // if (updateDataInput.allowed_fields !== undefined) updateData.allowedFields = updateDataInput.allowed_fields; // Removed: Not in schema
        if (updateDataInput.compliance_level !== undefined) {
            updateData.complianceLevel = mapComplianceLevelToInteger(updateDataInput.compliance_level); // Returns 0 | 1 | 2
        }
        // Note: 'plan' update is intentionally omitted as per original logic (handled by Stripe/billing flow elsewhere)

        const updatedSites = await db.update(sites)
            .set(updateData)
            .where(and(eq(sites.siteId, siteId), eq(sites.ownerSub, userSub)))
            .returning();

        if (updatedSites.length === 0) {
            // This means either the site didn't exist or the user didn't own it
            return createResponse(404, { error: "Site not found or access denied" });
        }

        return createResponse(200, transformSiteForApi(updatedSites[0]));
    }

    // Fallback for unhandled routes
    return createResponse(404, { error: `Not Found: Route ${routeKey} not handled.` });

  } catch (error: any) {
    console.error("Error processing request:", error);
    // Handle potential Zod errors specifically
    if (error instanceof z.ZodError) {
        return createResponse(400, { error: "Bad Request: Invalid input.", details: error.flatten().fieldErrors });
    }
    // Handle potential database errors (e.g., unique constraint violation)
    // Specific error codes/messages depend on the database driver (pg, mysql2, etc.)
    // Example for PostgreSQL unique violation:
    if (error.code === '23505') { // PostgreSQL unique violation code
         return createResponse(409, { error: "Conflict: A site with similar properties might already exist." });
    }
    // Generic internal error
    return createResponse(500, { error: "Internal Server Error", details: error.message });
  }
};