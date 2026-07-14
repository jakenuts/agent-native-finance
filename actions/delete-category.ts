/**
 * Delete a custom (non-system) category, nulling out references.
 * Run:  pnpm action delete-category --id cat_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, rules, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Delete a custom category. System categories cannot be deleted. Pass replacementCategoryId to bulk-reassign every transaction that used this category to another one (including locked transactions — they explicitly chose the category being deleted, so the lock moves with them); omit it to leave those transactions uncategorized instead. Rules that set this category have their setCategoryId cleared either way.",
  schema: z.object({
    id: z.string().describe("Category id to delete."),
    replacementCategoryId: z
      .string()
      .optional()
      .describe("Reassign transactions that used this category to this one instead of leaving them uncategorized."),
  }),
  readOnly: false,
  run: async ({ id, replacementCategoryId }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: categories.id, isSystem: categories.isSystem, name: categories.name, profile: categories.profile })
      .from(categories)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.id, id)));
    if (found.length === 0) throw new Error(`Category ${id} not found.`);
    if (found[0].isSystem) {
      throw new Error(`"${found[0].name}" is a system category and cannot be deleted.`);
    }

    if (replacementCategoryId) {
      if (replacementCategoryId === id) {
        throw new Error("Replacement category must be different from the category being deleted.");
      }
      const replacement = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.ownerEmail, owner), eq(categories.id, replacementCategoryId)));
      if (replacement.length === 0) {
        throw new Error(`Replacement category ${replacementCategoryId} not found.`);
      }
    }

    const [{ n: reassignedCount } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.categoryId, id)));

    // Reassign (or clear) transactions — locked transactions move too: the
    // user explicitly chose this category, and it's being deleted out from
    // under them, so the replacement (or uncategorized) carries the lock
    // state forward unchanged rather than silently unlocking them.
    await db
      .update(transactions)
      .set({ categoryId: replacementCategoryId ?? null })
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.categoryId, id)));
    await db
      .update(rules)
      .set({ setCategoryId: null })
      .where(and(eq(rules.ownerEmail, owner), eq(rules.setCategoryId, id)));
    await db
      .delete(categories)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.id, id)));

    return {
      ok: true,
      deleted: id,
      name: found[0].name,
      reassignedCount: Number(reassignedCount ?? 0),
      replacementCategoryId: replacementCategoryId ?? null,
    };
  },
});
