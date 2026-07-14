/**
 * List connected institutions with their accounts for the current owner.
 * Read-only. Run:  pnpm action list-accounts
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, institutions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "List connected institutions and their accounts (name, mask, type, subtype, balances, last synced, status, profile) for the current owner. Scoped to the active profile by default ('personal'/'business'); pass profile:'all' to see every account across both profiles, e.g. when helping the user split a mixed institution login.",
  schema: z.object({
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const insts = await db
      .select()
      .from(institutions)
      .where(eq(institutions.ownerEmail, owner))
      .orderBy(asc(institutions.name));

    const allAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner))
      .orderBy(asc(accounts.name));

    const scopedAccounts =
      effectiveProfile === "all"
        ? allAccounts
        : allAccounts.filter((a) => a.profile === effectiveProfile);
    const scopedAccountsByInst = new Map<string, typeof scopedAccounts>();
    for (const a of scopedAccounts) {
      const list = scopedAccountsByInst.get(a.institutionId) ?? [];
      list.push(a);
      scopedAccountsByInst.set(a.institutionId, list);
    }

    return insts
      .map((inst) => ({
        id: inst.id,
        name: inst.name,
        status: inst.status,
        lastSyncedAt: inst.lastSyncedAt,
        plaidInstitutionId: inst.plaidInstitutionId,
        defaultProfile: inst.defaultProfile,
        accounts: (scopedAccountsByInst.get(inst.id) ?? []).map((a) => ({
          id: a.id,
          // Friendly name: the nickname if set, else the institution name. Every
          // consumer (dashboard, pickers, etc.) gets this with no client change.
          name: a.displayName ?? a.name,
          // Raw institution-provided name, so the UI can show it as secondary /
          // helper text ("Bank name: …") alongside the nickname.
          officialName: a.name,
          // The nickname alone (null when none is set).
          displayName: a.displayName ?? null,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          currentBalance: (a.currentBalanceCents ?? 0) / 100,
          availableBalance:
            a.availableBalanceCents == null ? null : a.availableBalanceCents / 100,
          isoCurrency: a.isoCurrency,
          isActive: a.isActive,
          profile: a.profile,
          isManual: a.isManual,
        })),
      }))
      // Drop institutions with no accounts in scope (e.g. an all-business
      // institution when viewing 'personal') so the UI doesn't show empty cards.
      .filter((inst) => inst.accounts.length > 0 || effectiveProfile === "all");
  },
});
