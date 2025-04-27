import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/dashboard.tsx"), // Main dashboard (will be protected within the component)
  // Site Management Routes (assuming they are protected within the main layout/index)
  route("sites", "routes/sites/index.tsx"), // List sites
  route("sites/new", "routes/sites/new.tsx"), // Create new site form
  route("sites/:siteId", "routes/sites/detail.tsx"), // View/Edit site details
  // --- End Site Management ---
  // Payment Routes
  route("payment/success", "routes/payment/success.tsx"),
  route("payment/cancel", "routes/payment/cancel.tsx"),
  // --- End Payment Routes ---
  // Static Content Pages
  route("about", "routes/about.tsx"),
  route("privacy-policy", "routes/legal/privacy-policy.tsx"),
  route("terms-of-service", "routes/legal/terms-of-service.tsx"),
  route("docs/installation", "routes/docs/installation.tsx"),
  route("docs/cookieless-tracking", "routes/docs/cookieless-tracking.tsx"),
  // --- End Static Content ---
  // Auth Routes
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
  route("confirm-signup", "routes/confirm-signup.tsx"), // For email confirmation codes
] satisfies RouteConfig;
