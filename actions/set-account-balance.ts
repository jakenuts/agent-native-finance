/**
 * Set the balance of a MANUAL account by hand. Only works for manual
 * (non-Plaid) accounts — Plaid-linked balances are sync-owned and would be
 * overwritten on the next sync, so this REFUSES them with a clear error. Also
 * bumps the manual institution's last_synced_at so the UI shows a recent
 * "updated" time. Use as a manually-tracked balance declines (e.g. paying down
 * a closed card represented as a manual credit account).
 * Run:  pnpm action set-account-balance --accountId acc_123 --currentBalanceCents 2100000
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, institutions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { isManualInstitution } from "../server/lib/manual-account.js";

export default defineAction({
  description:
    "Set a MANUAL account's current (and optionally available) balance by hand, in cents. Manual-only: REFUSES Plaid-linked accounts (their balances are synced — use Refresh balances / Sync instead). Updates the account balance and bumps the institution's last-synced time. For a credit/loan manual account, currentBalanceCents is the amount still owed.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id of the manual account to update."),
    currentBalanceCents: z.number().int().describe("New current balance in cents (amount owed for credit/loan)."),
    availableBalanceCents: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Optional new available (spendable) balance in cents; null clears it."),
  }),
  readOnly: false,
  run: async (args) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        isManual: accounts.isManual,
        institutionId: accounts.institutionId,
      })
      .from(accounts)
      .where(eq(accounts.id, args.accountId));
    if (found.length === 0) throw new Error(`Account ${args.accountId} not found.`);
    const account = found[0];

    // Ownership + manual guard. Check both the account flag AND the owning
    // institution's manual status so a Plaid-linked account can never have its
    // sync-owned balance clobbered here.
    const instRows = await db
      .select({
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
        "This account's balance is synced from Plaid; use Refresh balances instead.",
      );
    }

    const nowIso = new Date().toISOString();
    await db
      .update(accounts)
      .set({
        currentBalanceCents: args.currentBalanceCents,
        // Only touch available when the caller explicitly passed it (including null).
        ...(args.availableBalanceCents !== undefined
          ? { availableBalanceCents: args.availableBalanceCents }
          : {}),
      })
      .where(eq(accounts.id, args.accountId));

    // Bump the manual institution's last-synced time so the UI shows a fresh
    // "updated <relative>" for this hand edit.
    await db
      .update(institutions)
      .set({ lastSyncedAt: nowIso })
      .where(eq(institutions.id, account.institutionId));

    return {
      ok: true,
      accountId: args.accountId,
      accountName: account.name,
      currentBalance: args.currentBalanceCents / 100,
      availableBalance:
        args.availableBalanceCents === undefined || args.availableBalanceCents === null
          ? null
          : args.availableBalanceCents / 100,
      updatedAt: nowIso,
    };
  },
});
