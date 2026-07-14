/**
 * Sandbox-only end-to-end proof: create a fake public_token, exchange it, and
 * pull accounts + transactions into the DB — no UI, no real credentials.
 * Requires PLAID_CLIENT_ID + your Sandbox PLAID_SECRET (PLAID_ENV=sandbox).
 *
 * Run:  pnpm action plaid-sandbox-connect
 *       pnpm action plaid-sandbox-connect --institutionId ins_109508
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getPlaid, Products, plaidEnv } from "../server/lib/plaid.js";
import { onboardAccessToken } from "../server/lib/finance-sync.js";
import { getDb } from "../server/db/index.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Connect a Plaid SANDBOX test bank and sync its accounts + transactions into Finance. For pipeline testing only.",
  schema: z.object({
    institutionId: z
      .string()
      .default("ins_109508")
      .describe("Sandbox institution id (default: First Platypus Bank)."),
  }),
  agentTool: false,
  run: async ({ institutionId }) => {
    const env = await plaidEnv();
    if (env !== "sandbox") {
      return {
        ok: false,
        error: `PLAID_ENV is "${env}". Set PLAID_ENV=sandbox to use this test action.`,
      };
    }
    const plaid = await getPlaid();
    const pub = await plaid.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: [Products.Transactions],
    });
    const exchange = await plaid.itemPublicTokenExchange({
      public_token: pub.data.public_token,
    });
    const result = await onboardAccessToken(getDb(), {
      ownerEmail: ownerEmail(),
      accessToken: exchange.data.access_token,
      itemId: exchange.data.item_id,
      plaidInstitutionId: institutionId,
    });
    return { ok: true, ...result };
  },
});
