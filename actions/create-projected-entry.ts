/**
 * Create a manual projected-income ledger entry ("we expect $X from renewals
 * on the 15th"). Quicken-style scheduled entry; income is NEGATIVE cents.
 * Run:  pnpm action create-projected-entry --date 2026-07-15 --amountCents -25000 --name "Expected renewals"
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, projectedEntries } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Create a manual projected-income ledger entry (an expected future cash event, e.g. 'we expect $250 from renewals on the 15th'). amountCents is SIGNED cents — NEGATIVE = expected income (the common case), positive = expected outflow; must be non-zero. `date` is the expected BANK date (when the money hits the account). Pass accountId (the target account, encouraged) so runway/plan funding projections can attribute it; the entry's profile is stamped from that account (or the active profile when no account). Source is 'manual', status starts 'projected' — resolve later via update-projected-entry (status 'received'|'missed'|'canceled') or resolve-stale-projections.",
  schema: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Expected BANK date (YYYY-MM-DD) — when the money should hit the account."),
    amountCents: z
      .number()
      .int()
      .refine((v) => v !== 0, { message: "amountCents must be non-zero (negative = income)." })
      .describe("Signed cents: NEGATIVE = expected income, positive = expected outflow."),
    name: z.string().min(1).max(160).describe("Display name, e.g. 'Example Customer · Elite'."),
    accountId: z.string().optional().describe("Target account the money is expected to hit."),
    notes: z.string().max(500).optional(),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile for this entry. Defaults to the chosen account's profile, else the active profile."),
  }),
  readOnly: false,
  run: async ({ date, amountCents, name, accountId, notes, profile }) => {
    const db = getDb();
    const owner = ownerEmail();

    let accountProfile: "personal" | "business" | null = null;
    if (accountId) {
      const acct = await db
        .select({ id: accounts.id, profile: accounts.profile })
        .from(accounts)
        .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, accountId)));
      if (acct.length === 0) throw new Error(`Account ${accountId} not found.`);
      accountProfile = acct[0].profile === "business" ? "business" : "personal";
    }

    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile =
      profile ?? accountProfile ?? (effectiveProfile === "all" ? "personal" : effectiveProfile);

    const id = `proj_${crypto.randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();

    await db.insert(projectedEntries).values({
      id,
      ownerEmail: owner,
      profile: targetProfile,
      accountId: accountId ?? null,
      date,
      amountCents,
      name,
      source: "manual",
      externalKey: `manual:${id}`,
      status: "projected",
      notes: notes ?? null,
      metadata: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return { ok: true, id, date, amountCents, name, profile: targetProfile };
  },
});
