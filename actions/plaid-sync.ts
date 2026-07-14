/**
 * Sync transactions for one institution (by id) or all of them.
 * Run:  pnpm action plaid-sync
 *       pnpm action plaid-sync --institutionId <uuid>
 * This is the deterministic operation a scheduled job / webhook will call.
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { syncAll, syncInstitution } from "../server/lib/finance-sync.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Pull the latest transactions from Plaid for one connected institution, or all of them. By default this first FORCES Plaid to re-poll the bank (`/transactions/refresh`) so you get today's just-posted transactions, not Plaid's cached snapshot — this is what makes 'Sync now' actually check the bank. Also refreshes balances. Pass forceBankRefresh:false for a cheap cached-delta sync (no bank re-poll). Note: pending transactions only appear if the bank exposes them to Plaid (Example Bank does; Example Bank does not — those stay balance-only until they post).",
  schema: z.object({
    institutionId: z
      .string()
      .optional()
      .describe("Institution id to sync; omit to sync all."),
    forceBankRefresh: z
      .boolean()
      .default(true)
      .describe(
        "Force Plaid to re-pull from the bank before syncing (default true). Set false for a fast cached-delta sync with no bank re-poll.",
      ),
  }),
  run: async ({ institutionId, forceBankRefresh }) => {
    const db = getDb();
    const changed = institutionId
      ? await syncInstitution(db, institutionId, { forceBankRefresh })
      : await syncAll(db, ownerEmail(), { forceBankRefresh });
    return { ok: true, changed };
  },
});
