/**
 * Merge one account's history into another and dedupe overlapping rows.
 * Run:  pnpm action merge-accounts --fromAccountId acc_a --intoAccountId acc_b
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { mergeAccounts } from "../server/lib/account-merge.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Merge a duplicate account into a target account: moves all transactions, recurring links, and payment-plan references from `fromAccountId` onto `intoAccountId`, dedupes transaction rows that now collide (same date+amount, one imported via CSV and one Plaid-real — keeps the Plaid-real row), then deletes the emptied source account. Use for 'same real account shows up twice' cases: a manual CSV-imported account duplicating a Plaid-linked one, or an account duplicated across two Plaid Items for the same bank login. Always call get-merge-suggestions first and confirm with the user before merging.",
  schema: z.object({
    fromAccountId: z.string().describe("Duplicate/source account id — will be deleted after merge."),
    intoAccountId: z.string().describe("Surviving target account id — keeps this id, absorbs the source's history."),
  }),
  run: async ({ fromAccountId, intoAccountId }) => {
    const db = getDb();
    return mergeAccounts(db, ownerEmail(), fromAccountId, intoAccountId);
  },
});
