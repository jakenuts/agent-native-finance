/**
 * Delete a MANUAL account and its transactions. Manual-only — Plaid-linked
 * accounts must be removed via remove-institution (which also cleans up the
 * Plaid Item). Requires confirmDelete: true. Clears any recurring/payment-plan
 * references to the account (keeps those rows, just unlinks). If this was the
 * institution's LAST account, the now-empty manual institution is removed too.
 * Run:  pnpm action delete-manual-account --accountId acc_123 --confirmDelete
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, institutions, paymentPlans, recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { isManualInstitution } from "../server/lib/manual-account.js";

export default defineAction({
  description:
    "Delete a MANUAL account and all its transactions. Manual-only: REFUSES Plaid-linked accounts (use remove-institution for those). Requires confirmDelete: true. Recurring/payment-plan references to the account are unlinked (rows kept). If it was the manual institution's last account, the empty institution is removed too.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id of the manual account to delete."),
    confirmDelete: z
      .boolean()
      .describe("Must be true — deleting an account and its transactions cannot be undone."),
  }),
  readOnly: false,
  run: async ({ accountId, confirmDelete }) => {
    const db = getDb();
    const owner = ownerEmail();

    if (!confirmDelete) {
      throw new Error("Deleting a manual account requires confirmDelete: true.");
    }

    const found = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        isManual: accounts.isManual,
        institutionId: accounts.institutionId,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (found.length === 0) throw new Error(`Account ${accountId} not found.`);
    const account = found[0];

    const instRows = await db
      .select({
        id: institutions.id,
        name: institutions.name,
        ownerEmail: institutions.ownerEmail,
        status: institutions.status,
        accessToken: institutions.accessToken,
      })
      .from(institutions)
      .where(eq(institutions.id, account.institutionId));
    const inst = instRows[0];
    if (!inst || inst.ownerEmail !== owner) {
      throw new Error("Account does not belong to the current owner.");
    }
    if (!account.isManual || !isManualInstitution(inst)) {
      throw new Error(
        "This is a Plaid-linked account; delete it via remove-institution instead so the Plaid connection is cleaned up too.",
      );
    }

    // Count transactions before deleting, for the report.
    const [{ n: txCount } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));

    // Unlink recurring + payment-plan references (keep the rows, just clear the
    // dangling account pointer — same pattern as remove-institution's hard delete).
    await db.update(recurring).set({ accountId: null }).where(eq(recurring.accountId, accountId));
    await db.update(paymentPlans).set({ cardAccountId: null }).where(eq(paymentPlans.cardAccountId, accountId));
    await db.update(paymentPlans).set({ payFromAccountId: null }).where(eq(paymentPlans.payFromAccountId, accountId));

    await db.delete(transactions).where(eq(transactions.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.id, accountId));

    // If the manual institution now has no accounts left, remove it too.
    const [{ n: remaining } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(accounts)
      .where(eq(accounts.institutionId, inst.id));
    const institutionRemoved = Number(remaining ?? 0) === 0;
    if (institutionRemoved) {
      await db.delete(institutions).where(eq(institutions.id, inst.id));
    }

    return {
      ok: true,
      accountId,
      accountName: account.name,
      transactionsDeleted: Number(txCount ?? 0),
      institutionRemoved,
      institutionId: inst.id,
      institutionName: inst.name,
    };
  },
});
