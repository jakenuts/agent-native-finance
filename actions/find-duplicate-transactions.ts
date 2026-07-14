/**
 * Find likely-duplicate transaction rows WITHIN accounts (not a merge — see
 * merge-accounts/dedupe-account-transactions for that). Handles both
 * plaid-vs-plaid duplicates (two Plaid Items produced different
 * plaid_transaction_ids for the same real charge) and rm_-import-vs-plaid
 * duplicates where dates differ slightly. Read-only.
 * Run:  pnpm action find-duplicate-transactions --accountId acc_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { findDuplicateGroups } from "../server/lib/tx-dedupe.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Find likely-duplicate transactions within accounts: same amount, dates within 3 days, similar merchant name. Catches both (a) plaid-vs-plaid duplicates from merged Plaid Items producing different transaction ids for the same real charge, and (b) Rocket Money CSV-import-vs-Plaid duplicates where dates differ slightly (posted vs transaction date). Returns groups with a survivor (kept) and losers (would be removed) plus a confidence (high = exact date+amount+merchant; medium = within tolerance). Pass crossAccounts:true to ALSO look for the same real charge duplicated across two different accounts (e.g. the same login connected twice as separate Plaid Items) — these cross-account groups are capped at 'medium' confidence unless the merchant name matches strongly (bumped to 'high'). Read-only — call consolidate-duplicates to actually remove them, always dryRun first.",
  schema: z.object({
    accountId: z.string().optional().describe("Scope to one account. Omit to scan all accounts."),
    limit: z.coerce.number().int().min(1).max(1000).default(200).describe("Max groups to return."),
    crossAccounts: z
      .boolean()
      .default(false)
      .describe("Also look for duplicate candidates across DIFFERENT accounts (default false — same-account only)."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ accountId, limit, crossAccounts }) => {
    const db = getDb();
    const owner = ownerEmail();
    const groups = await findDuplicateGroups(db, owner, { accountId, limit, crossAccounts });
    const byConfidence = { high: 0, medium: 0 };
    for (const g of groups) byConfidence[g.confidence]++;
    return {
      groupCount: groups.length,
      byConfidence,
      groups,
    };
  },
});
