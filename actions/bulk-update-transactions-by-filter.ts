/**
 * Bulk-update EVERY transaction matching a filter (same filter shape as
 * list-transactions / delete-transactions — see server/lib/tx-filters.ts).
 * This is the "select all matching" companion to bulk-update-transactions:
 * when the user selects every transaction matching the current /transactions
 * filters (potentially thousands), we DON'T fetch all their ids into the
 * client — we apply the patch server-side by filter instead. Mirrors
 * delete-transactions' filter/profile/guardrail structure and
 * bulk-update-transactions' patch semantics.
 * Run:  pnpm action bulk-update-transactions-by-filter --datePreset last30 --isIgnored true --dryRun true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { buildTxFilterConditions, hasAnyFilter, txFilterSchema } from "../server/lib/tx-filters.js";

export default defineAction({
  description:
    "Bulk-update EVERY transaction matching a filter (same filter fields as list-transactions: accountIds, dateFrom/dateTo/datePreset, categoryIds incl 'uncategorized', search/searchScope, amount, source, recurringId, includeIgnored) with the same patch fields as bulk-update-transactions: categoryId (locks each, like set-transaction-category), merchantName (rename), isIgnored, and/or note. This is the 'select all matching' path for the /transactions page — use it instead of fetching thousands of ids to bulk-update-transactions (which caps at 500). Preview the exact filter via list-transactions first, then apply here. ALWAYS dryRun first (default true) — it returns { matched } (the count that would change) without writing. Refuses to run with NO filter fields at all (protects the whole ledger). Scoped to the active profile unless a profile override is passed.",
  schema: z.object({
    ...txFilterSchema,
    // Patch fields — mirror bulk-update-transactions exactly.
    categoryId: z
      .string()
      .nullable()
      .optional()
      .describe("Category id to assign to every match (or null to clear); locks each transaction like set-transaction-category."),
    merchantName: z.string().max(120).optional().describe("Custom display name applied to every match."),
    isIgnored: z.boolean().optional().describe("Set the ignored flag on every match."),
    note: z.string().max(2000).optional().describe("Free-text note applied to every match; empty string clears it."),
    dryRun: z
      .boolean()
      .default(true)
      .describe("Preview { matched } count without writing anything. Always run this first."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  readOnly: false,
  run: async (args) => {
    const { categoryId, merchantName, isIgnored, note, dryRun, profile } = args;
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    // `categoryId` here is the PATCH (assign a category), which collides by name
    // with tx-filters' legacy single-category filter — so build the filter args
    // explicitly (categoryIds only) to keep the patch value out of the WHERE.
    const filterArgs = {
      accountId: args.accountId,
      accountIds: args.accountIds,
      categoryIds: args.categoryIds,
      search: args.search,
      searchScope: args.searchScope,
      month: args.month,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      datePreset: args.datePreset,
      amount: args.amount,
      includeIgnored: args.includeIgnored,
      recurringId: args.recurringId,
      source: args.source,
    };

    // Same whole-ledger guardrail as delete-transactions.
    if (!hasAnyFilter(filterArgs)) {
      throw new Error(
        "Refusing to run with no filters at all — this would match every transaction. Pass at least one filter (accountIds, date range, categoryIds, search, amount, source, recurringId).",
      );
    }

    // Build the patch first so we can reject a no-op before scanning.
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

    const conditions = [eq(transactions.ownerEmail, owner)];
    if (effectiveProfile !== "all") {
      conditions.push(eq(transactions.profile, effectiveProfile));
    }
    conditions.push(...buildTxFilterConditions(filterArgs));
    const where = and(...conditions);

    const [{ n: matched } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(where);
    const matchedCount = Number(matched ?? 0);

    const updated = Object.keys(patch).filter((k) => k !== "categoryLocked");

    if (dryRun) {
      return { ok: true, dryRun: true, matched: matchedCount, updated };
    }

    if (matchedCount === 0) {
      return { ok: true, dryRun: false, matched: 0, changed: 0, updated };
    }

    patch.updatedAt = new Date().toISOString();
    await db.update(transactions).set(patch).where(where);

    return {
      ok: true,
      dryRun: false,
      matched: matchedCount,
      changed: matchedCount,
      updated: updated,
    };
  },
});
