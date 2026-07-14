/**
 * Read-only scan for likely-duplicate accounts (same mask + compatible type
 * across different institutions) to present before merging anything.
 * Run:  pnpm action get-merge-suggestions
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { mergeSuggestions } from "../server/lib/account-merge.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Read-only: scan connected accounts for likely duplicates (same last-4 mask + compatible account type appearing at more than one institution) — e.g. a manual CSV-imported 'Adv Plus Banking ...0537' duplicating a Plaid-linked account of the same number, or the same account duplicated across two Plaid Items for the same bank login. Each suggestion names a target (prefers Plaid-linked + most recently synced) and the source account id(s) to merge into it via merge-accounts. Also flags when merging would leave an institution with zero accounts (institutionFullyDuplicate) — offer remove-institution for that case too. Call this before ever calling merge-accounts, and show the user the suggestions before merging.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    return { suggestions: await mergeSuggestions(db, ownerEmail()) };
  },
});
