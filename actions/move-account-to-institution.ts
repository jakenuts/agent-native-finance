/**
 * Reparent an account under a different institution card, without merging it
 * into any single other account (e.g. attach a leftover manual "Regular
 * Savings" history-only account under the surviving Example Bank card).
 * Run:  pnpm action move-account-to-institution --accountId acc_a --institutionId inst_b
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { moveAccountToInstitution } from "../server/lib/account-merge.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Move one account (and its transactions) to a different institution, without merging it into another account — for attaching a leftover manual/CSV-imported account (e.g. a history-only savings account) visually under a surviving bank connection's institution card, when it isn't a true duplicate of any single existing account there.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id to move."),
    institutionId: z.string().describe("Destination fp_institutions.id."),
  }),
  run: async ({ accountId, institutionId }) => {
    const db = getDb();
    return moveAccountToInstitution(db, ownerEmail(), accountId, institutionId);
  },
});
