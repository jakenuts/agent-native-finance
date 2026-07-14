/**
 * Bulk-delete transactions matching a filter (same filter shape as
 * list-transactions — see server/lib/tx-filters.ts). Built for the
 * "I imported ~27K Rocket Money rows, remove everything before a cutoff on
 * this account" workflow: imported (CSV, plaid_transaction_id LIKE 'rm_%')
 * rows are disposable and re-importable, so they're deleted by default;
 * real Plaid-synced rows are only ever deleted when the caller explicitly
 * opts in. ALWAYS dryRun first (the default) and show the user the
 * imported/plaid counts before running for real.
 * Run:  pnpm action delete-transactions --datePreset lastYear --dryRun true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { isImportedTransactionId } from "../server/lib/account-merge.js";
import { buildTxFilterConditions, hasAnyFilter, txFilterSchema } from "../server/lib/tx-filters.js";

export default defineAction({
  description:
    "Bulk-delete transactions matching a filter (same filter fields as list-transactions: accountIds, dateFrom/dateTo/datePreset, categoryIds, search/searchScope, amount, source, recurringId). Built for cleaning up bulk-imported Rocket Money CSV history — e.g. 'delete everything imported on this account before this date'. Default onlyImported:true deletes ONLY imported rows (plaid_transaction_id LIKE 'rm_%') even if the filter also matches real Plaid rows (reports plaidSkipped); pass onlyImported:false + confirmDelete:true to also delete matching Plaid-real rows (prefer ignoring those via bulk-update-transactions instead — deleting real synced data cannot be recovered by re-import). ALWAYS dryRun first (default true) and show the user the { total, imported, plaid } counts before running for real. Refuses to run with NO filters at all (protects the whole ledger) unless allowAll:true AND confirmDelete:true are both passed.",
  schema: z.object({
    ...txFilterSchema,
    onlyImported: z
      .boolean()
      .default(true)
      .describe(
        "Default true: only delete rows whose plaid_transaction_id starts 'rm_' (imported/disposable), even if the filter also matches Plaid-real rows — those are counted in plaidSkipped instead. Set false to also allow deleting matching Plaid-real rows (requires confirmDelete:true).",
      ),
    allowAll: z
      .boolean()
      .default(false)
      .describe("Required (with confirmDelete) to run with NO filter fields at all — protects against wiping the whole ledger."),
    confirmDelete: z
      .boolean()
      .default(false)
      .describe("Required literal true for any real (non-dryRun) delete, and required alongside allowAll for a no-filter run."),
    dryRun: z.boolean().default(true).describe("Preview { total, imported, plaid } counts without deleting anything."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  run: async (args) => {
    const { onlyImported, allowAll, confirmDelete, dryRun, profile } = args;
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const anyFilter = hasAnyFilter(args);
    if (!anyFilter && !(allowAll && confirmDelete)) {
      throw new Error(
        "Refusing to run with no filters at all — this would match every transaction. Pass at least one filter (accountIds, date range, category, search, amount, source, recurringId), or explicitly pass allowAll:true AND confirmDelete:true to proceed against the entire ledger.",
      );
    }

    const conditions = [eq(transactions.ownerEmail, owner)];
    if (effectiveProfile !== "all") {
      conditions.push(eq(transactions.profile, effectiveProfile));
    }
    conditions.push(...buildTxFilterConditions(args));
    const where = and(...conditions);

    const matched = await db
      .select({ id: transactions.id, plaidTransactionId: transactions.plaidTransactionId })
      .from(transactions)
      .where(where);

    const importedIds = matched.filter((r) => isImportedTransactionId(r.plaidTransactionId)).map((r) => r.id);
    const plaidIds = matched.filter((r) => !isImportedTransactionId(r.plaidTransactionId)).map((r) => r.id);

    const willDeletePlaid = !onlyImported;
    const idsToDelete = willDeletePlaid ? matched.map((r) => r.id) : importedIds;
    const plaidSkipped = willDeletePlaid ? 0 : plaidIds.length;

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        total: matched.length,
        imported: importedIds.length,
        plaid: plaidIds.length,
        wouldDelete: idsToDelete.length,
        plaidSkipped,
        onlyImported,
      };
    }

    if (!confirmDelete) {
      throw new Error("Real delete requires confirmDelete:true. Always dryRun first and confirm counts with the user.");
    }
    if (willDeletePlaid && plaidIds.length > 0 && !confirmDelete) {
      throw new Error("Deleting Plaid-real rows requires confirmDelete:true.");
    }

    if (idsToDelete.length === 0) {
      return {
        ok: true,
        dryRun: false,
        total: matched.length,
        imported: importedIds.length,
        plaid: plaidIds.length,
        deleted: 0,
        plaidSkipped,
        onlyImported,
      };
    }

    // Chunk deletes to stay well under SQL parameter limits for large filters.
    const CHUNK = 500;
    let deleted = 0;
    for (let i = 0; i < idsToDelete.length; i += CHUNK) {
      const chunk = idsToDelete.slice(i, i + CHUNK);
      await db.delete(transactions).where(and(eq(transactions.ownerEmail, owner), inArray(transactions.id, chunk)));
      deleted += chunk.length;
    }

    return {
      ok: true,
      dryRun: false,
      total: matched.length,
      imported: importedIds.length,
      plaid: plaidIds.length,
      deleted,
      plaidSkipped,
      onlyImported,
    };
  },
});
