/**
 * Set (or clear) a user-friendly nickname for an account. Works for BOTH
 * Plaid-linked and manual accounts — the nickname is app-side metadata stored
 * in fp_accounts.display_name, kept separate from the institution-provided
 * `name` so a Plaid sync never overwrites it. Empty string or null clears the
 * nickname (the account reverts to showing its institution name). Every action
 * that surfaces an account name to the user returns COALESCE(display_name,
 * name), so a rename takes effect everywhere (dashboard, pickers, runway,
 * payment plans, transactions) with no other change.
 * Run:  pnpm action rename-account --accountId acc_123 --displayName "Corp Card 7507"
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, institutions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Set a friendly nickname (display name) for an account, e.g. rename 'CORP Account - Business Advantage Cash Rewards - 7507' to 'Corp Card 7507'. Works for BOTH Plaid-linked and manual accounts — the nickname is app-side metadata that a Plaid sync never overwrites, and the institution-provided name is preserved underneath. Pass an empty string or null for displayName to CLEAR the nickname (revert to the institution name). Once set, every place that shows this account's name (dashboard, account pickers, runway, payment plans, transactions) uses the nickname automatically.",
  schema: z.object({
    accountId: z.string().describe("fp_accounts.id of the account to rename."),
    displayName: z
      .string()
      .max(120)
      .nullable()
      .describe(
        "New friendly nickname. Empty string or null clears it (reverts to the institution-provided name).",
      ),
  }),
  readOnly: false,
  run: async (args) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        institutionId: accounts.institutionId,
      })
      .from(accounts)
      .where(eq(accounts.id, args.accountId));
    if (found.length === 0) throw new Error(`Account ${args.accountId} not found.`);
    const account = found[0];

    // Ownership guard via the owning institution (same pattern as the other
    // per-account mutations). No manual/Plaid guard: nicknames are app-side
    // metadata and apply to both — a sync will never clobber display_name.
    const instRows = await db
      .select({ ownerEmail: institutions.ownerEmail })
      .from(institutions)
      .where(eq(institutions.id, account.institutionId));
    const inst = instRows[0];
    if (!inst || inst.ownerEmail !== owner) {
      throw new Error("Account does not belong to the current owner.");
    }

    // Trim; empty (or null/omitted) clears the nickname.
    const trimmed = args.displayName?.trim() || null;

    await db
      .update(accounts)
      .set({ displayName: trimmed })
      .where(eq(accounts.id, args.accountId));

    return {
      ok: true,
      accountId: args.accountId,
      displayName: trimmed,
      officialName: account.name,
      // The name every consumer now sees (COALESCE(display_name, name)).
      name: trimmed ?? account.name,
    };
  },
});
