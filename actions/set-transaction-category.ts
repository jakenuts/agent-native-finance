/**
 * Set (or clear) the category on one transaction, locking it by default so
 * sync and rules won't overwrite the manual choice.
 * Run:  pnpm action set-transaction-category --transactionId xxx --categoryId cat_dining
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Set or clear the category on a single transaction. Locks the assignment by default so sync/rules never overwrite it; pass lock=false to leave it unlocked.",
  schema: z.object({
    transactionId: z.string().describe("Transaction id."),
    categoryId: z
      .string()
      .nullable()
      .describe("Category id, or null to clear the category."),
    lock: z
      .boolean()
      .default(true)
      .describe("Mark category_locked so automation keeps this choice. Default true."),
  }),
  readOnly: false,
  run: async ({ transactionId, categoryId, lock }) => {
    const db = getDb();
    const owner = ownerEmail();

    const txn = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, transactionId)));
    if (txn.length === 0) throw new Error(`Transaction ${transactionId} not found.`);

    if (categoryId !== null) {
      const cat = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.ownerEmail, owner), eq(categories.id, categoryId)));
      if (cat.length === 0) throw new Error(`Category ${categoryId} not found.`);
    }

    await db
      .update(transactions)
      .set({
        categoryId,
        categoryLocked: lock,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, transactionId)));

    return { ok: true, transactionId, categoryId, locked: lock };
  },
});
