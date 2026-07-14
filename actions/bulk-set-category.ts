/**
 * Set the same category on many transactions at once (locks each one).
 * Run:  pnpm action bulk-set-category --transactionIds '["id1","id2"]' --categoryId cat_dining
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Assign one category to many transactions in a single call. Each transaction is locked so automation keeps the assignment. Prefer create-rule for recurring merchants.",
  schema: z.object({
    transactionIds: z.array(z.string()).min(1).max(200).describe("Transaction ids."),
    categoryId: z.string().describe("Category id to assign."),
  }),
  readOnly: false,
  run: async ({ transactionIds, categoryId }) => {
    const db = getDb();
    const owner = ownerEmail();

    const cat = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.id, categoryId)));
    if (cat.length === 0) throw new Error(`Category ${categoryId} not found.`);

    const found = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.ownerEmail, owner), inArray(transactions.id, transactionIds)),
      );
    const foundIds = found.map((r) => r.id);
    if (foundIds.length === 0) throw new Error("No matching transactions found.");

    await db
      .update(transactions)
      .set({
        categoryId,
        categoryLocked: true,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(transactions.ownerEmail, owner), inArray(transactions.id, foundIds)));

    return {
      ok: true,
      categoryId,
      updated: foundIds.length,
      missing: transactionIds.filter((id) => !foundIds.includes(id)),
    };
  },
});
