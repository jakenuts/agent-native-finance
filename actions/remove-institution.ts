/**
 * Remove a connected institution: either keep its data as a manual/history
 * institution (default) or hard-delete it and everything under it.
 * Run:  pnpm action remove-institution --institutionId inst_a
 *       pnpm action remove-institution --institutionId inst_a --keepDataAsManual false --confirmDelete true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { removeInstitution } from "../server/lib/account-merge.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Remove a connected institution — for a duplicate or dead Plaid connection (e.g. an old re-linked Item superseded by a newer one, or a dead Venmo login). Two modes: keepDataAsManual (default true) converts it to a manual/history institution — transaction history stays, but it's disconnected from Plaid; keepDataAsManual:false permanently deletes the institution, its accounts, and every transaction under it and REQUIRES confirmDelete:true as a literal safety confirmation. When the institution has a real Plaid connection and removeAtPlaid (default true), calls Plaid's item/remove first, which frees up a limited trial/production connection slot — errors from already-dead Items are tolerated so local cleanup still proceeds. ALWAYS ask the user to confirm before calling this, especially with keepDataAsManual:false.",
  schema: z.object({
    institutionId: z.string().describe("fp_institutions.id to remove."),
    keepDataAsManual: z
      .boolean()
      .default(true)
      .describe("Keep transaction history as a disconnected manual institution (default true). false permanently deletes everything."),
    removeAtPlaid: z
      .boolean()
      .default(true)
      .describe("Call Plaid's /item/remove to free the connection slot, if this is a real Plaid Item (default true)."),
    confirmDelete: z
      .boolean()
      .optional()
      .describe("Required literal true when keepDataAsManual is false — explicit confirmation for permanent data deletion."),
  }),
  run: async ({ institutionId, keepDataAsManual, removeAtPlaid, confirmDelete }) => {
    const db = getDb();
    return removeInstitution(db, ownerEmail(), {
      institutionId,
      keepDataAsManual,
      removeAtPlaid,
      confirmDelete,
    });
  },
});
