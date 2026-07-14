/**
 * Apply the same patch (category, merchant name, ignored flag, note) to many
 * transactions at once. Supersedes bulk-set-category for category-only bulk
 * edits (kept for backward compatibility) — this is the general bulk mutation
 * backing the /transactions selection action bar.
 * Run:  pnpm action bulk-update-transactions --transactionIds '["id1","id2"]' --isIgnored true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Apply the same edit to many transactions at once: categoryId (locks each, like set-transaction-category), merchantName (rename), isIgnored, and/or note. Pass only the fields that change; each provided field is applied to every id in transactionIds. Returns the changed count. Prefer this over looping set-transaction-category/update-transaction for multi-select bulk edits.",
  schema: z.object({
    transactionIds: z.array(z.string()).min(1).max(500).describe("Transaction ids (max 500)."),
    categoryId: z.string().nullable().optional().describe("Category id to assign to all (or null to clear); locks each transaction."),
    merchantName: z.string().max(120).optional().describe("Custom display name applied to all."),
    isIgnored: z.boolean().optional().describe("Set the ignored flag on all."),
    note: z.string().max(2000).optional().describe("Free-text note applied to all; empty string clears it."),
  }),
  readOnly: false,
  run: async ({ transactionIds, categoryId, merchantName, isIgnored, note }) => {
    const db = getDb();
    const owner = ownerEmail();

    const patch: Record<string, unknown> = {};
    if (categoryId !== undefined) {
      if (categoryId !== null) {
        const cat = await db
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.ownerEmail, owner), eq(categories.id, categoryId)));
        if (cat.length === 0) throw new Error(`Category ${categoryId} not found.`);
      }
      patch.categoryId = categoryId;
      patch.categoryLocked = true;
    }
    if (merchantName !== undefined) patch.merchantName = merchantName.trim() || null;
    if (isIgnored !== undefined) patch.isIgnored = isIgnored;
    if (note !== undefined) patch.note = note.trim() === "" ? null : note;

    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one of categoryId, merchantName, isIgnored, note.");
    }
    patch.updatedAt = new Date().toISOString();

    const found = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), inArray(transactions.id, transactionIds)));
    const foundIds = found.map((r) => r.id);
    if (foundIds.length === 0) throw new Error("No matching transactions found.");

    await db
      .update(transactions)
      .set(patch)
      .where(and(eq(transactions.ownerEmail, owner), inArray(transactions.id, foundIds)));

    return {
      ok: true,
      changed: foundIds.length,
      missing: transactionIds.filter((id) => !foundIds.includes(id)),
      updated: Object.keys(patch).filter((k) => k !== "updatedAt" && k !== "categoryLocked"),
    };
  },
});
