import { createAuthPlugin } from "@agent-native/core/server";

const rawAppTitle = "Finance";
const appTitle = rawAppTitle === "{" + "{APP_TITLE}}" ? "Finance" : rawAppTitle;

export default createAuthPlugin({
  // Machine-to-machine callbacks that must be reachable without a session.
  // Plaid signs webhook deliveries; the handler verifies them itself.
  publicPaths: ["/api/plaid-webhook"],
  marketing: {
    appName: appTitle,
    tagline:
      "Manage personal and business cashflow with agent-native finance actions.",
    features: [
      "Sync accounts and transactions from Plaid",
      "Track recurring bills, payment plans, budgets, and projected income",
      "Ask the in-app agent to analyze cashflow and update durable finance views",
    ],
  },
});
