/**
 * Reassign an account to a different profile (personal/business), cascading
 * to its transactions and any recurring entries linked to it. This is how a
 * mixed institution login (e.g. one Example Bank login holding both a
 * personal checking account and a business checking account) gets split
 * correctly — each account is fixed individually.
 * Run:  pnpm action set-account-profile --accountId acc_123 --profile business
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Reassign one account to 'personal' or 'business', cascading the change to every transaction on that account and any recurring entries linked to it. Use this to fix a mixed-login institution (e.g. one bank login holding both a personal and a business account) — the account, not the institution, is the source of truth for profile.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id to reassign."),
    profile: z.enum(["personal", "business"]),
  }),
  readOnly: false,
  run: async ({ accountId, profile }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: accounts.id, name: accounts.name, profile: accounts.profile })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (found.length === 0) throw new Error(`Account ${accountId} not found.`);
    const account = found[0];

    // Count-before-update so the reported "updated" counts reflect exactly
    // the rows this call cascades to, regardless of driver update-result shape.
    const [{ n: transactionCount } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));
    const [{ n: recurringCount } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(recurring)
      .where(eq(recurring.accountId, accountId));

    await db.update(accounts).set({ profile }).where(eq(accounts.id, accountId));
    await db.update(transactions).set({ profile }).where(eq(transactions.accountId, accountId));
    await db.update(recurring).set({ profile }).where(eq(recurring.accountId, accountId));

    void owner;

    return {
      ok: true,
      accountId,
      accountName: account.name,
      previousProfile: account.profile,
      profile,
      transactionsUpdated: Number(transactionCount ?? 0),
      recurringUpdated: Number(recurringCount ?? 0),
    };
  },
});
