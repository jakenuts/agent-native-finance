/**
 * Dedupe same-money (date + amount) transaction rows on ONE account where one
 * row is CSV-imported (rm_ prefix) and the other is Plaid-real. Useful
 * standalone (without a full account merge) when Plaid's HISTORICAL_UPDATE
 * backfills transaction history that overlaps rows already sitting on the
 * SAME account from an earlier CSV import — see AGENTS.md for that workflow.
 * Idempotent: re-running with nothing left to dedupe returns 0.
 * Run:  pnpm action dedupe-account-transactions --accountId acc_a
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { dedupeAccountTransactions } from "../server/lib/account-merge.js";

export default defineAction({
  description:
    "Dedupe transactions on ONE account: removes CSV-imported rows (plaid_transaction_id starting 'rm_') that collide on (date, amount) with a Plaid-real row on the SAME account, keeping the Plaid-real row (carrying over its note/category if the survivor lacks them). Idempotent — safe to re-run, returns 0 once clean. Use this after Plaid backfills historical transactions on an account that already had CSV-imported history for the same period.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id to dedupe."),
  }),
  run: async ({ accountId }) => {
    const db = getDb();
    return dedupeAccountTransactions(db, accountId);
  },
});
