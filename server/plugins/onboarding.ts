/**
 * Finance setup steps.
 *
 * Compose the framework onboarding plugin so the built-in setup routes/default
 * steps stay mounted, then add app-specific provider steps. Values saved by
 * these forms land in Agent Native scoped secrets; runtime helpers fall back to
 * deployment env vars for Railway/Nisse/CI.
 */
import {
  createOnboardingPlugin,
  registerOnboardingStep,
} from "@agent-native/core/onboarding";
import { registerRequiredSecret } from "@agent-native/core/secrets";

import { hasPlaidConfig } from "../lib/plaid.js";
import { isProjectionSourceConfigured } from "../lib/projection-sources.js";

const basePlugin = createOnboardingPlugin();

function registerFinanceSecrets() {
  registerRequiredSecret({
    key: "PLAID_CLIENT_ID",
    label: "Plaid client ID",
    description: "Used to connect bank accounts and refresh balances/transactions.",
    scope: "workspace",
    kind: "api-key",
    required: false,
  });
  registerRequiredSecret({
    key: "PLAID_SECRET",
    label: "Plaid secret",
    description: "Server-side Plaid credential for Link, sync, and webhooks.",
    scope: "workspace",
    kind: "api-key",
    required: false,
  });
  registerRequiredSecret({
    key: "RECURLY_API_KEY",
    label: "Recurly API key",
    description: "Optional source for automated projected-income refreshes.",
    scope: "workspace",
    kind: "api-key",
    required: false,
  });
}

export default async (nitroApp: any): Promise<void> => {
  await basePlugin(nitroApp);
  registerFinanceSecrets();

  registerOnboardingStep({
    id: "finance-plaid",
    order: 50,
    required: false,
    title: "Connect Plaid",
    description:
      "Enable live bank connections, transaction sync, balance refresh, and Plaid webhooks.",
    methods: [
      {
        id: "plaid-keys",
        kind: "form",
        primary: true,
        label: "Save Plaid keys",
        payload: {
          writeScope: "workspace",
          saveTo: "scoped-secrets",
          secretDescription: "Finance Plaid configuration",
          fields: [
            { key: "PLAID_CLIENT_ID", label: "Client ID" },
            { key: "PLAID_SECRET", label: "Secret", secret: true },
            { key: "PLAID_ENV", label: "Environment", placeholder: "sandbox" },
            {
              key: "PLAID_WEBHOOK_URL",
              label: "Webhook URL",
              placeholder: "https://app.example.com/api/plaid-webhook",
            },
            {
              key: "PLAID_REDIRECT_URI",
              label: "OAuth redirect URI",
              placeholder: "https://app.example.com/plaid/callback",
            },
          ],
        },
      },
      {
        id: "plaid-docs",
        kind: "link",
        label: "Open Plaid dashboard",
        payload: { url: "https://dashboard.plaid.com/developers/keys", external: true },
      },
      {
        id: "agent-help",
        kind: "agent-task",
        label: "Ask the agent",
        payload: {
          prompt:
            "Walk me through configuring Plaid for Finance. Identify which values belong in setup, deployment env vars, and GitHub/Railway secrets.",
        },
      },
    ],
    isComplete: hasPlaidConfig,
  });

  registerOnboardingStep({
    id: "finance-projection-source",
    order: 55,
    required: false,
    title: "Projection source",
    description:
      "Add Recurly API credentials if you want automated subscription-renewal projections.",
    methods: [
      {
        id: "recurly-api",
        kind: "form",
        primary: true,
        label: "Save Recurly key",
        payload: {
          writeScope: "workspace",
          saveTo: "scoped-secrets",
          secretDescription: "Finance Recurly projection source",
          fields: [
            { key: "RECURLY_API_KEY", label: "API key", secret: true },
            { key: "RECURLY_SUBDOMAIN", label: "Console subdomain", placeholder: "app" },
          ],
        },
      },
      {
        id: "manual-csv",
        kind: "agent-task",
        label: "Use manual or CSV",
        payload: {
          prompt:
            "Use Finance without Recurly API automation. Show me how to add manual projected entries or import a Recurly renewals CSV.",
        },
      },
    ],
    isComplete: () => isProjectionSourceConfigured("recurly-api"),
  });
};
