/**
 * Manually link (or unlink) a transaction to a recurring entry.
 * Run:  pnpm action assign-transaction-recurring --transactionId tx_xxx --recurringId rec_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Link a transaction to a recurring bill/subscription/income entry, or pass recurringId: null to unlink it.",
  schema: z.object({
    transactionId: z.string(),
    recurringId: z.string().nullable(),
  }),
  readOnly: false,
  run: async ({ transactionId, recurringId }) => {
    const db = getDb();
    const owner = ownerEmail();

    const tx = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, transactionId)));
    if (tx.length === 0) throw new Error(`Transaction ${transactionId} not found.`);

    if (recurringId) {
      const rec = await db
        .select({ id: recurring.id })
        .from(recurring)
        .where(and(eq(recurring.ownerEmail, owner), eq(recurring.id, recurringId)));
      if (rec.length === 0) throw new Error(`Recurring ${recurringId} not found.`);
    }

    await db
      .update(transactions)
      .set({ recurringId, updatedAt: new Date().toISOString() })
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, transactionId)));

    return { ok: true, transactionId, recurringId };
  },
});
