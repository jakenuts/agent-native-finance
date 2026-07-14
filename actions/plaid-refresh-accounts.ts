/**
 * After a Plaid Link UPDATE MODE session completes (adding/removing
 * authorized accounts on an EXISTING Item), Link's onSuccess fires but there
 * is no new public_token to exchange — the Item already has an access token.
 * Call this instead of plaid-exchange-public-token to pick up any
 * newly-authorized accounts and sync their transactions.
 * Run:  pnpm action plaid-refresh-accounts --institutionId <uuid>
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { institutions } from "../server/db/schema.js";
import { upsertAccounts, syncInstitution } from "../server/lib/finance-sync.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Refresh an institution's accounts after a Plaid Link UPDATE MODE session (add/remove accounts on an existing connection) — picks up newly authorized accounts and syncs their transactions. Call this instead of plaid-exchange-public-token when the Link session was opened in update mode (no public_token to exchange).",
  schema: z.object({
    institutionId: z.string().describe("fp_institutions.id that was just managed via update mode."),
  }),
  run: async ({ institutionId }) => {
    const db = getDb();
    const owner = ownerEmail();

    const rows = await db.select().from(institutions).where(eq(institutions.id, institutionId));
    const inst = rows[0];
    if (!inst) throw new Error(`Institution ${institutionId} not found.`);
    if (inst.ownerEmail !== owner) {
      throw new Error("Institution does not belong to the current owner.");
    }
    const isRealItem = inst.status !== "manual" && inst.accessToken !== "manual_import";
    if (!isRealItem) {
      throw new Error(`"${inst.name}" has no active Plaid connection.`);
    }

    const accountCount = await upsertAccounts(db, {
      ownerEmail: owner,
      institutionId,
      accessToken: inst.accessToken,
    });
    const transactionCount = await syncInstitution(db, institutionId);

    return {
      ok: true,
      institutionId,
      institutionName: inst.name,
      accounts: accountCount,
      transactions: transactionCount,
    };
  },
});
