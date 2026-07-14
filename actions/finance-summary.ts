/**
 * Read-only snapshot to verify data landed: counts + a few recent transactions.
 * Run:  pnpm action finance-summary
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, categories, institutions, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Finance data snapshot: how many institutions, accounts, and transactions are stored, plus the latest few. Scoped to the active profile by default; pass profile:'all' to see totals across both.",
  schema: z.object({
    recent: z.number().int().min(0).max(50).default(10),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ recent, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const profileCond = effectiveProfile !== "all";

    const [inst] = await db
      .select({ n: sql<number>`count(*)` })
      .from(institutions)
      .where(eq(institutions.ownerEmail, owner));
    const [acct] = await db
      .select({ n: sql<number>`count(*)` })
      .from(accounts)
      .where(
        profileCond
          ? and(eq(accounts.ownerEmail, owner), eq(accounts.profile, effectiveProfile))
          : eq(accounts.ownerEmail, owner),
      );
    const [tx] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(
        profileCond
          ? and(eq(transactions.ownerEmail, owner), eq(transactions.profile, effectiveProfile))
          : eq(transactions.ownerEmail, owner),
      );

    const latest = await db
      .select({
        date: transactions.date,
        name: transactions.name,
        merchant: transactions.merchantName,
        amountCents: transactions.amountCents,
        currency: transactions.isoCurrency,
        pending: transactions.pending,
        categoryId: transactions.categoryId,
        plaidCategory: transactions.pfcPrimary,
      })
      .from(transactions)
      .where(
        profileCond
          ? and(eq(transactions.ownerEmail, owner), eq(transactions.profile, effectiveProfile))
          : eq(transactions.ownerEmail, owner),
      )
      .orderBy(desc(transactions.date))
      .limit(recent);

    // Prefer the assigned category name; keep the raw Plaid code alongside.
    const catRows = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.ownerEmail, owner));
    const catName = new Map(catRows.map((c) => [c.id, c.name]));

    return {
      institutions: Number(inst?.n ?? 0),
      accounts: Number(acct?.n ?? 0),
      transactions: Number(tx?.n ?? 0),
      recent: latest.map((t) => ({
        date: t.date,
        name: t.name,
        merchant: t.merchant,
        amountCents: t.amountCents,
        currency: t.currency,
        pending: t.pending,
        category: t.categoryId ? (catName.get(t.categoryId) ?? null) : null,
        plaidCategory: t.plaidCategory,
        amount: (t.amountCents ?? 0) / 100,
      })),
    };
  },
});
