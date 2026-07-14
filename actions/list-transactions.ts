/**
 * List transactions with paging, search, and rich filters (accounts,
 * categories, date presets/range, amount, recurring link, source). The
 * agent's main analytical listing tool and the data source for the
 * /transactions page. Read-only. Filter semantics are shared with
 * delete-transactions via server/lib/tx-filters.ts, so a filter previewed
 * here matches exactly what a bulk delete would remove.
 * Run:  pnpm action list-transactions --limit 20 --datePreset last30
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, categories, institutions, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { isImportedTransactionId } from "../server/lib/account-merge.js";
import { buildTxFilterConditions, txFilterSchema } from "../server/lib/tx-filters.js";

export default defineAction({
  description:
    "List transactions for the current owner. Supports paging, search (searchScope 'name' default matches only the displayed name, 'all' also matches the raw description), account/category multi-select, date range (explicit from/to, a datePreset like last30/thisMonth, or the legacy month param), amount filters (exactly/between/gt/lt), recurringId, and source (imported = Rocket Money CSV rows vs plaid = real Plaid-synced rows). This is the agent's main analytical listing tool for browsing/filtering transactions. Output rows include account/institution names and mask, category, note, source, and flags (isIgnored, isTaxDeductible).",
  schema: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    ...txFilterSchema,
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const { limit, offset, profile } = args;
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const conditions = [eq(transactions.ownerEmail, owner)];
    if (effectiveProfile !== "all") {
      conditions.push(eq(transactions.profile, effectiveProfile));
    }
    conditions.push(...buildTxFilterConditions(args));

    const where = and(...conditions);

    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        name: transactions.name,
        merchantName: transactions.merchantName,
        amountCents: transactions.amountCents,
        pending: transactions.pending,
        pfcPrimary: transactions.pfcPrimary,
        accountId: transactions.accountId,
        categoryId: transactions.categoryId,
        categoryLocked: transactions.categoryLocked,
        note: transactions.note,
        isIgnored: transactions.isIgnored,
        isTaxDeductible: transactions.isTaxDeductible,
        recurringId: transactions.recurringId,
        profile: transactions.profile,
        plaidTransactionId: transactions.plaidTransactionId,
      })
      .from(transactions)
      .where(where)
      .orderBy(desc(transactions.date), desc(transactions.id))
      .limit(limit)
      .offset(offset);

    // Assigned-category names (preferred over the raw Plaid category).
    const catRows = await db
      .select({ id: categories.id, name: categories.name, group: categories.categoryGroup })
      .from(categories)
      .where(eq(categories.ownerEmail, owner));
    const catById = new Map(catRows.map((c) => [c.id, c]));

    // Account + institution names for the "account ··mask" row subtitle.
    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
        institutionId: accounts.institutionId,
      })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    const instRows = await db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions)
      .where(eq(institutions.ownerEmail, owner));
    const instById = new Map(instRows.map((i) => [i.id, i.name]));
    const acctById = new Map(
      acctRows.map((a) => [
        a.id,
        { name: a.name, mask: a.mask, institutionName: instById.get(a.institutionId) ?? null },
      ]),
    );

    const [{ n: total } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(where);

    return {
      total: Number(total ?? 0),
      limit,
      offset,
      rows: rows.map((r) => {
        const cat = r.categoryId ? catById.get(r.categoryId) : undefined;
        const acct = acctById.get(r.accountId);
        return {
          id: r.id,
          date: r.date,
          name: r.name,
          rawName: r.name,
          merchantName: r.merchantName,
          amount: (r.amountCents ?? 0) / 100,
          pending: r.pending,
          // Assigned category (preferred) + raw Plaid category for reference.
          categoryId: r.categoryId,
          category: cat?.name ?? null,
          categoryGroup: cat?.group ?? null,
          categoryLocked: r.categoryLocked,
          plaidCategory: r.pfcPrimary,
          // Kept for backwards compatibility with existing UI.
          pfcPrimary: r.pfcPrimary,
          note: r.note,
          accountId: r.accountId,
          accountName: acct?.name ?? null,
          accountMask: acct?.mask ?? null,
          institutionName: acct?.institutionName ?? null,
          isIgnored: Boolean(r.isIgnored),
          isTaxDeductible: Boolean(r.isTaxDeductible),
          recurringId: r.recurringId,
          profile: r.profile,
          source: isImportedTransactionId(r.plaidTransactionId) ? "imported" : "plaid",
        };
      }),
    };
  },
});
