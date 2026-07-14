/**
 * Same-merchant transaction history: pass either a transactionId (its
 * merchant key is derived) or a merchantKey directly. Uses the same
 * normalizeMerchantKey as recurring detection so "CORNER MARKET #2" and
 * "CORNER MARKET #5" group together. Read-only.
 * Run:  pnpm action merchant-history --transactionId tx_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { normalizeMerchantKey } from "../server/lib/recurring.js";

export default defineAction({
  description:
    "List other transactions from the same merchant (normalized match, so store-number/date suffixes are ignored — e.g. all 'Corner Market #2', 'Corner Market #5' group together). Pass transactionId to derive the merchant from that transaction, or merchantKey directly. Returns count, total spent, and a capped list of matches. Scoped to the active profile by default; pass profile:'all' to include both.",
  schema: z.object({
    transactionId: z.string().optional().describe("Derive the merchant key from this transaction."),
    merchantKey: z.string().optional().describe("Normalized merchant key to match directly."),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ transactionId, merchantKey, limit, profile }) => {
    if (!transactionId && !merchantKey) {
      throw new Error("Pass either transactionId or merchantKey.");
    }
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    let key = merchantKey ? normalizeMerchantKey(merchantKey) : "";
    let anchorId: string | null = null;
    if (transactionId) {
      const [tx] = await db
        .select({ id: transactions.id, name: transactions.name, merchantName: transactions.merchantName })
        .from(transactions)
        .where(eq(transactions.id, transactionId));
      if (!tx) throw new Error(`Transaction ${transactionId} not found.`);
      anchorId = tx.id;
      key = normalizeMerchantKey(tx.merchantName || tx.name);
    }
    if (!key) {
      return { merchantKey: key, count: 0, totalCents: 0, total: 0, rows: [] };
    }

    const conditions = [eq(transactions.ownerEmail, owner)];
    if (effectiveProfile !== "all") {
      conditions.push(eq(transactions.profile, effectiveProfile));
    }

    // normalizeMerchantKey isn't SQL-expressible; scan owner's (profile-scoped)
    // transactions and filter in memory (dataset is small in this sandbox; fine for now).
    const all = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        name: transactions.name,
        merchantName: transactions.merchantName,
        amountCents: transactions.amountCents,
        pending: transactions.pending,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.date));

    const matches = all.filter((t) => normalizeMerchantKey(t.merchantName || t.name) === key);
    const totalCents = matches.reduce((sum, t) => sum + (t.amountCents ?? 0), 0);

    return {
      merchantKey: key,
      anchorTransactionId: anchorId,
      count: matches.length,
      totalCents,
      total: totalCents / 100,
      rows: matches.slice(0, limit).map((t) => ({
        id: t.id,
        date: t.date,
        name: t.name,
        merchantName: t.merchantName,
        amount: (t.amountCents ?? 0) / 100,
        pending: t.pending,
        categoryId: t.categoryId,
      })),
    };
  },
});
