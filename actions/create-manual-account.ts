/**
 * Create a MANUAL (non-Plaid) account with a user-set balance, under a
 * synthetic "manual" institution. Use this to represent an account Plaid can't
 * link — a closed-but-in-repayment credit card, an external loan, a cash
 * stash — at its real balance, then update it by hand with set-account-balance
 * as it changes. A manual credit/loan account can back a payment plan
 * (cardAccountId) for payoff tracking.
 * Run:  pnpm action create-manual-account --institutionName Example Card --accountName "Visa ··4607" --accountClass credit --currentBalanceCents 2117924
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { accounts } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import {
  MANUAL_ACCOUNT_CLASSES,
  findOrCreateManualInstitution,
} from "../server/lib/manual-account.js";

export default defineAction({
  description:
    "Create a manual (non-Plaid) account with a user-set balance under a manual institution. Use for an account Plaid can't link — a closed/in-repayment credit card, an external loan, a cash stash. accountClass maps to the account type (depository/credit/loan/investment/other); for credit/loan the currentBalanceCents is the amount OWED. Reuses an existing manual institution with the same name; if a REAL Plaid institution shares the name a separate manual one is still created and the result flags it so you can suggest a merge. Update the balance later with set-account-balance.",
  schema: z.object({
    institutionName: z.string().min(1).max(120).describe("Institution/bank display name, e.g. 'Example Card'."),
    accountName: z.string().min(1).max(120).describe("Account display name, e.g. 'Visa ··4607'."),
    mask: z.string().max(12).optional().describe("Last few digits of the account number (no '••' prefix)."),
    accountClass: z
      .enum(MANUAL_ACCOUNT_CLASSES)
      .describe("Account class → fp_accounts.type: depository | credit | loan | investment | other."),
    subtype: z.string().max(40).optional().describe("Optional subtype, e.g. 'credit card', 'checking'."),
    currentBalanceCents: z
      .number()
      .int()
      .describe("Current balance in cents. For credit/loan this is the amount owed (positive)."),
    availableBalanceCents: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Optional available (spendable) balance in cents; null/omitted if not applicable."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile to create the account in. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async (args) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, args.profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const inst = await findOrCreateManualInstitution(db, owner, args.institutionName, targetProfile);

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await db.insert(accounts).values({
      id,
      ownerEmail: owner,
      institutionId: inst.institutionId,
      // Manual accounts have no Plaid account id; use a stable synthetic one
      // (mirrors rm-import's `manual_<id>` convention) so the NOT NULL column
      // is satisfied and it never collides with a real Plaid account_id.
      plaidAccountId: `manual_${id}`,
      name: args.accountName,
      officialName: null,
      mask: args.mask?.trim() || null,
      type: args.accountClass,
      subtype: args.subtype?.trim() || null,
      currentBalanceCents: args.currentBalanceCents,
      availableBalanceCents: args.availableBalanceCents ?? null,
      isoCurrency: "USD",
      isActive: true,
      profile: targetProfile,
      isManual: true,
      createdAt: nowIso,
    });

    return {
      ok: true,
      institutionId: inst.institutionId,
      institutionCreated: inst.created,
      accountId: id,
      institutionName: args.institutionName.trim(),
      accountName: args.accountName,
      profile: targetProfile,
      balance: args.currentBalanceCents / 100,
      // When a real Plaid institution already uses this name, the user may
      // prefer to merge the manual account under it later (get-merge-suggestions
      // / merge-accounts). Surfaced, not enforced.
      duplicatesRealInstitutionName: inst.realPlaidNameCollision,
    };
  },
});
