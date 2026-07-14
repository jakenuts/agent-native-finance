/**
 * Plaid client, configured from environment. Server-only — never expose the
 * secret to the browser. Keys live in .env (gitignored):
 *   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox|production
 */
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";
import { hasConfigValues, resolveConfigValue } from "./config-secrets.js";

export type PlaidEnv = "sandbox" | "production";

export async function plaidEnv(): Promise<PlaidEnv> {
  const e = ((await resolveConfigValue("PLAID_ENV")) ?? "sandbox").toLowerCase();
  return e === "production" ? "production" : "sandbox";
}

export async function hasPlaidConfig(): Promise<boolean> {
  return hasConfigValues(["PLAID_CLIENT_ID", "PLAID_SECRET"]);
}

export async function getPlaidLinkConfig(): Promise<{
  webhookUrl: string | null;
  redirectUri: string | null;
}> {
  const [webhookUrl, redirectUri] = await Promise.all([
    resolveConfigValue("PLAID_WEBHOOK_URL"),
    resolveConfigValue("PLAID_REDIRECT_URI"),
  ]);
  return { webhookUrl, redirectUri };
}

export async function getPlaid(): Promise<PlaidApi> {
  const [clientId, secret, env] = await Promise.all([
    resolveConfigValue("PLAID_CLIENT_ID"),
    resolveConfigValue("PLAID_SECRET"),
    plaidEnv(),
  ]);
  if (!clientId || !secret) {
    throw new Error(
      "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET through setup, scoped secrets, or deployment environment variables.",
    );
  }
  const config = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });
  return new PlaidApi(config);
}

export { Products, CountryCode };

/** Convert a Plaid decimal amount (e.g. 12.34) to signed integer cents. */
export function toCents(amount: number | null | undefined): number {
  if (amount == null) return 0;
  return Math.round(amount * 100);
}
