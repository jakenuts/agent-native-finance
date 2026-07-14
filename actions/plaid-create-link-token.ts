/**
 * Create a Plaid Link token for the browser to open Plaid Link and connect a
 * real bank. Server-side (uses the secret). The returned link_token is safe to
 * hand to the client.
 *
 * Two modes:
 *   - NEW connection (default): standard Link token with `products` set —
 *     creates a brand-new Plaid Item on success.
 *   - UPDATE mode (`institutionId` param set, and that institution has a real
 *     Plaid access token): Link token is created WITH `access_token` set and
 *     NO `products`, so Link reopens against the SAME existing Item instead
 *     of minting a new one. `update.account_selection_enabled: true` lets the
 *     user add/remove authorized accounts (e.g. add a business account that
 *     wasn't selected the first time) on that one login. This is how the
 *     "re-link the same bank" duplicate-Item problem is avoided — always
 *     prefer this over a fresh Connect flow when the institution already
 *     exists.
 * Run:  pnpm action plaid-create-link-token
 *       pnpm action plaid-create-link-token --institutionId inst_123
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getPlaid, getPlaidLinkConfig, Products, CountryCode } from "../server/lib/plaid.js";
import { ownerEmail } from "../server/lib/owner.js";
import { getDb } from "../server/db/index.js";
import { institutions } from "../server/db/schema.js";

export default defineAction({
  description:
    "Create a Plaid Link token to connect a bank account. Pass institutionId to reopen Link in UPDATE MODE against an existing connection (to add/remove authorized accounts, e.g. a business account the user didn't select initially) — this reuses the same Plaid Item instead of creating a duplicate one. NEVER create a fresh connection for a bank that's already linked; use update mode instead.",
  schema: z.object({
    institutionId: z
      .string()
      .optional()
      .describe(
        "fp_institutions.id to manage in UPDATE MODE (add/remove accounts on the existing Plaid Item). Omit to start a brand-new connection.",
      ),
  }),
  run: async ({ institutionId }) => {
    const db = getDb();
    const owner = ownerEmail();

    let updateModeAccessToken: string | null = null;
    let updateModeInstitutionName: string | null = null;
    if (institutionId) {
      const rows = await db
        .select()
        .from(institutions)
        .where(eq(institutions.id, institutionId));
      const inst = rows[0];
      if (!inst) throw new Error(`Institution ${institutionId} not found.`);
      if (inst.ownerEmail !== owner) {
        throw new Error("Institution does not belong to the current owner.");
      }
      const isRealItem = inst.status !== "manual" && inst.accessToken !== "manual_import";
      if (!isRealItem) {
        throw new Error(
          `"${inst.name}" has no active Plaid connection (it's a manual/imported institution) — update mode isn't available for it. Connect it fresh instead.`,
        );
      }
      updateModeAccessToken = inst.accessToken;
      updateModeInstitutionName = inst.name;
    }

    const plaid = await getPlaid();
    const { webhookUrl, redirectUri } = await getPlaidLinkConfig();
    const res = await plaid.linkTokenCreate({
      // Plaid production forbids PII (e.g. email) in client_user_id — use an opaque stable id.
      user: { client_user_id: "finance-owner-1" },
      client_name: "Finance",
      country_codes: [CountryCode.Us],
      language: "en",
      ...(updateModeAccessToken
        ? {
            access_token: updateModeAccessToken,
            update: { account_selection_enabled: true },
          }
        : { products: [Products.Transactions] }),
      ...(webhookUrl ? { webhook: webhookUrl } : {}),
      // Required for OAuth institutions. Must exactly match a redirect URI
      // registered in the Plaid dashboard (Developers -> API).
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    return {
      linkToken: res.data.link_token,
      expiration: res.data.expiration,
      updateMode: Boolean(updateModeAccessToken),
      institutionId: institutionId ?? null,
      institutionName: updateModeInstitutionName,
    };
  },
});
