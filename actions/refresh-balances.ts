/**
 * Force a real-time balance re-poll for one institution (or every non-manual
 * institution) WITHOUT a full transaction sync. Useful right after moving
 * money between accounts, when the user wants an up-to-date balance but
 * doesn't want to wait on (or trigger) a transaction sync.
 * Run:  pnpm action refresh-balances
 *       pnpm action refresh-balances --institutionId <uuid>
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { institutions } from "../server/db/schema.js";
import { refreshAccountBalances } from "../server/lib/finance-sync.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Force a real-time balance re-poll (via Plaid's accountsBalanceGet) for one institution, or every connected non-manual institution if institutionId is omitted — WITHOUT a full transaction sync. Use this when the user wants a fresh balance right after moving money (e.g. a transfer or payment just cleared) and doesn't want to wait for/trigger a transaction sync. Returns per-institution { institutionId, name, updated, accountsUpdated, path, error? }. Note: this forces Plaid to re-poll the institution, but the institution's own feed into Plaid can still lag a few minutes to hours behind the bank's real-time balance — the returned number is Plaid's freshest, not necessarily the bank's this-second number.",
  schema: z.object({
    institutionId: z
      .string()
      .optional()
      .describe("Institution id to refresh; omit to refresh all connected (non-manual) institutions."),
  }),
  run: async ({ institutionId }) => {
    const db = getDb();
    const owner = ownerEmail();

    const targets = institutionId
      ? await db.select().from(institutions).where(eq(institutions.id, institutionId))
      : await db.select().from(institutions).where(eq(institutions.ownerEmail, owner));

    const results: Array<{
      institutionId: string;
      name: string;
      updated: boolean;
      accountsUpdated: number;
      error?: string;
    }> = [];

    for (const inst of targets) {
      if (inst.status === "manual" || inst.accessToken === "manual_import") {
        results.push({ institutionId: inst.id, name: inst.name, updated: false, accountsUpdated: 0 });
        continue;
      }
      try {
        const { updated } = await refreshAccountBalances(db, inst.id);
        results.push({
          institutionId: inst.id,
          name: inst.name,
          updated: updated > 0,
          accountsUpdated: updated,
        });
      } catch (err) {
        results.push({
          institutionId: inst.id,
          name: inst.name,
          updated: false,
          accountsUpdated: 0,
          error: err instanceof Error ? err.message : "Balance refresh failed",
        });
      }
    }

    return { ok: true, results };
  },
});
