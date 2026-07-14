/**
 * Edit a MANUAL account's metadata (name, mask, class, subtype). Manual-only —
 * Plaid-linked account metadata comes from the bank via sync, so this REFUSES
 * non-manual accounts. Balances are edited separately with set-account-balance;
 * profile with set-account-profile.
 * Run:  pnpm action update-manual-account --accountId acc_123 --accountName "Example Card Visa (closed)"
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, institutions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { MANUAL_ACCOUNT_CLASSES, isManualInstitution } from "../server/lib/manual-account.js";

export default defineAction({
  description:
    "Edit a MANUAL account's metadata: accountName, mask, accountClass (depository/credit/loan/investment/other → fp_accounts.type), and/or subtype. Manual-only: REFUSES Plaid-linked accounts (their details come from the bank). Balances go through set-account-balance; profile through set-account-profile.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id of the manual account to edit."),
    accountName: z.string().min(1).max(120).optional(),
    mask: z.string().max(12).nullable().optional().describe("Last few digits; null clears it."),
    accountClass: z.enum(MANUAL_ACCOUNT_CLASSES).optional().describe("New account class → fp_accounts.type."),
    subtype: z.string().max(40).nullable().optional().describe("New subtype; null clears it."),
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
        "This account is synced from Plaid; its details come from the bank and can't be edited here.",
      );
    }

    const patch: Record<string, unknown> = {};
    if (args.accountName !== undefined) patch.name = args.accountName;
    if (args.mask !== undefined) patch.mask = args.mask?.trim() || null;
    if (args.accountClass !== undefined) patch.type = args.accountClass;
    if (args.subtype !== undefined) patch.subtype = args.subtype?.trim() || null;

    if (Object.keys(patch).length > 0) {
      await db.update(accounts).set(patch).where(eq(accounts.id, args.accountId));
    }

    return { ok: true, accountId: args.accountId, accountName: patch.name ?? account.name };
  },
});
