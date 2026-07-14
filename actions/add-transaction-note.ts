/**
 * DEPRECATED: use update-transaction { id, note } instead — kept for
 * backward compatibility (agent memory of the old name, existing scripts).
 * Attach or replace a free-text note on a transaction.
 * Run:  pnpm action add-transaction-note --transactionId xxx --note "Split with Sam"
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Deprecated: use update-transaction { id, note } instead. Attach or replace a free-text note on a transaction. Pass an empty string to clear.",
  schema: z.object({
    transactionId: z.string().describe("Transaction id."),
    note: z.string().max(2000).describe("Note text; empty string clears the note."),
  }),
  readOnly: false,
  run: async ({ transactionId, note }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, transactionId)));
    if (found.length === 0) throw new Error(`Transaction ${transactionId} not found.`);

    const cleanNote = note.trim() === "" ? null : note;
    await db
      .update(transactions)
      .set({ note: cleanNote, updatedAt: new Date().toISOString() })
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, transactionId)));

    return { ok: true, transactionId, note: cleanNote };
  },
});
