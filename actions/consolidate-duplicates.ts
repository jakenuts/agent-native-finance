/**
 * Consolidate (delete) duplicate transaction rows found by
 * find-duplicate-transactions. Always dryRun first to see counts.
 * Run:  pnpm action consolidate-duplicates --accountId acc_xxx --dryRun true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { consolidateDuplicates, findDuplicateGroups } from "../server/lib/tx-dedupe.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Consolidate (delete) duplicate transactions found by find-duplicate-transactions: keeps the highest-authority survivor per group (Plaid-real > CSV-imported, then most-recently-synced account for cross-account groups), carries over note/category/tax-deductible flag the survivor is missing, re-links recurring/payment-plan references, then deletes the losers. Pass groupIds to consolidate specific groups (e.g. after the user reviews a panel), or omit to consolidate every group at minConfidence or above. Pass crossAccounts:true to match find-duplicate-transactions' crossAccounts scan (must be the same value used to find the groupIds being consolidated). ALWAYS dryRun first and show the user counts before running for real — never mass-consolidate without the user reviewing, especially at 'medium' confidence.",
  schema: z.object({
    accountId: z.string().optional().describe("Scope to one account. Omit to scan all accounts."),
    groupIds: z
      .array(z.string())
      .optional()
      .describe("Consolidate only these specific group ids (from find-duplicate-transactions)."),
    minConfidence: z
      .enum(["high", "medium"])
      .default("high")
      .describe("'high' = exact date+amount+merchant only (safe to automate). 'medium' also includes fuzzy/tolerance matches (review individually)."),
    crossAccounts: z
      .boolean()
      .default(false)
      .describe("Must match the crossAccounts value used in find-duplicate-transactions when consolidating cross-account groupIds."),
    dryRun: z.boolean().default(true).describe("Preview counts without deleting anything."),
  }),
  readOnly: false,
  run: async ({ accountId, groupIds, minConfidence, crossAccounts, dryRun }) => {
    const db = getDb();
    const owner = ownerEmail();

    if (dryRun) {
      const groups = await findDuplicateGroups(db, owner, { accountId, limit: 1000, crossAccounts });
      const wanted = groups.filter((g) => {
        if (groupIds && groupIds.length > 0 && !groupIds.includes(g.id)) return false;
        if (minConfidence === "high") return g.confidence === "high";
        return true;
      });
      const transactionsToRemove = wanted.reduce((sum, g) => sum + g.losers.length, 0);
      return {
        ok: true,
        dryRun: true,
        groupsConsidered: wanted.length,
        transactionsRemoved: transactionsToRemove,
        recurringRelinked: 0,
        paymentPlansRelinked: 0,
      };
    }

    return consolidateDuplicates(db, owner, { accountId, groupIds, minConfidence, crossAccounts });
  },
});
