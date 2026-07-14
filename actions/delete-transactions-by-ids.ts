/**
 * Delete a specific set of transactions by id (the /transactions multi-select
 * "Delete" flow). Imported (Rocket Money CSV) rows are deleted freely — they're
 * disposable/re-importable. Plaid-real rows are only deleted when
 * confirmPlaidDelete is explicitly passed; otherwise they're reported back as
 * skippedPlaid so the UI can offer "Ignore instead".
 * Run:  pnpm action delete-transactions-by-ids --transactionIds '["id1","id2"]'
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { isImportedTransactionId } from "../server/lib/account-merge.js";

export default defineAction({
  description:
    "Delete specific transactions by id (max 500). Imported (Rocket Money CSV, plaid_transaction_id LIKE 'rm_%') rows are deleted freely since they're disposable and re-importable from the original CSV. Plaid-real rows are only deleted when confirmPlaidDelete:true is passed — otherwise they are skipped and returned in skippedPlaid so the caller can offer 'Ignore instead' (prefer ignoring real synced data over deleting it, since it can't be re-imported).",
  schema: z.object({
    transactionIds: z.array(z.string()).min(1).max(500).describe("Transaction ids to delete (max 500)."),
    confirmPlaidDelete: z
      .boolean()
      .default(false)
      .describe("Pass true to also delete any Plaid-real rows in the selection (default: skipped)."),
  }),
  run: async ({ transactionIds, confirmPlaidDelete }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: transactions.id, plaidTransactionId: transactions.plaidTransactionId })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), inArray(transactions.id, transactionIds)));

    const importedRows = found.filter((r) => isImportedTransactionId(r.plaidTransactionId));
    const plaidRows = found.filter((r) => !isImportedTransactionId(r.plaidTransactionId));

    const idsToDelete = confirmPlaidDelete ? found.map((r) => r.id) : importedRows.map((r) => r.id);
    const skippedPlaidIds = confirmPlaidDelete ? [] : plaidRows.map((r) => r.id);

    if (idsToDelete.length > 0) {
      await db
        .delete(transactions)
        .where(and(eq(transactions.ownerEmail, owner), inArray(transactions.id, idsToDelete)));
    }

    const foundIds = new Set(found.map((r) => r.id));
    const missing = transactionIds.filter((id) => !foundIds.has(id));

    return {
      ok: true,
      deleted: idsToDelete.length,
      imported: importedRows.length,
      plaid: plaidRows.length,
      skippedPlaid: skippedPlaidIds.length,
      skippedPlaidIds,
      missing,
    };
  },
});
