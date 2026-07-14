/**
 * Get full detail for a single transaction: all fields plus joined
 * account/institution, category, and recurring name. Backs the transaction
 * detail Sheet on /transactions and /dashboard.
 * Read-only. Run:  pnpm action get-transaction --id tx_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, categories, institutions, recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Get full detail for one transaction: all fields (amount, date, pending, raw Plaid name/category, note, flags) plus the joined account (name/mask), institution name, assigned category, and linked recurring name if any.",
  schema: z.object({
    id: z.string().describe("Transaction id."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const rows = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, id)));
    if (rows.length === 0) throw new Error(`Transaction ${id} not found.`);
    const tx = rows[0];

    const [acct] = tx.accountId
      ? await db.select().from(accounts).where(eq(accounts.id, tx.accountId))
      : [];
    const [inst] = acct?.institutionId
      ? await db.select().from(institutions).where(eq(institutions.id, acct.institutionId))
      : [];
    const [cat] = tx.categoryId
      ? await db.select().from(categories).where(eq(categories.id, tx.categoryId))
      : [];
    const [rec] = tx.recurringId
      ? await db.select().from(recurring).where(eq(recurring.id, tx.recurringId))
      : [];

    return {
      id: tx.id,
      date: tx.date,
      authorizedDate: tx.authorizedDate,
      name: tx.name,
      rawName: tx.name,
      merchantName: tx.merchantName,
      amount: (tx.amountCents ?? 0) / 100,
      amountCents: tx.amountCents,
      isoCurrency: tx.isoCurrency,
      pending: tx.pending,
      plaidCategory: tx.pfcPrimary,
      pfcPrimary: tx.pfcPrimary,
      pfcDetailed: tx.pfcDetailed,
      categoryId: tx.categoryId,
      category: cat?.name ?? null,
      categoryGroup: cat?.categoryGroup ?? null,
      categoryLocked: tx.categoryLocked,
      note: tx.note,
      isIgnored: Boolean(tx.isIgnored),
      isTaxDeductible: Boolean(tx.isTaxDeductible),
      recurringId: tx.recurringId,
      recurringName: rec?.name ?? null,
      accountId: tx.accountId,
      // Friendly name: the nickname if set, else the institution name.
      accountName: (acct?.displayName ?? acct?.name) ?? null,
      accountMask: acct?.mask ?? null,
      accountType: acct?.type ?? null,
      institutionId: inst?.id ?? null,
      institutionName: inst?.name ?? null,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  },
});
