/**
 * Sync upcoming subscription renewals DIRECTLY from the Recurly API into the
 * projected-income ledger — no CSV export needed. Fetches active
 * subscriptions renewing within the window and feeds them through the SAME
 * idempotent import path as import-recurly-renewals (shared
 * recurly:<uuid>:<renewalDate> keys), so API sync and CSV imports coexist:
 * re-syncing updates changed rows and never duplicates.
 * Requires the optional Recurly API projection source
 * (RECURLY_API_KEY + optional RECURLY_SUBDOMAIN), supplied through setup scoped
 * secrets or deployment environment variables.
 * Run (CLI/dev):  pnpm action sync-recurly-renewals --days 35 --dryRun true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { importRecurlyRenewals } from "../server/lib/projections.js";
import { fetchProjectionSourceRenewals } from "../server/lib/projection-sources.js";

export default defineAction({
  description:
    "Refresh projected income from the optional Recurly API projection source: fetches ACTIVE subscriptions whose current period ends within the next `days` days and upserts them into the projected-income ledger (same idempotent recurly:<uuid>:<renewalDate> keys as the CSV import — safe to run repeatedly; changed renewals update, resolved rows are never downgraded). $0 free/dev plans are skipped. Each renewal becomes a 'projected' entry dated renewal + payoutLagDays (default 2). Pass accountId (deposit account) so runway attributes the income; profile stamps from that account. dryRun defaults FALSE here (unlike the CSV import) because this is the recurring refresh path — pass dryRun:true to preview. Requires RECURLY_API_KEY via setup scoped secrets or deployment env; if missing, use import-recurly-renewals or manual entries instead.",
  schema: z.object({
    days: z
      .coerce.number()
      .int()
      .min(1)
      .max(120)
      .default(35)
      .describe("Forward window in days to project renewals for (default 35)."),
    accountId: z
      .string()
      .optional()
      .describe("Target account the payouts hit (business checking). Strongly encouraged."),
    payoutLagDays: z
      .coerce.number()
      .int()
      .min(0)
      .max(30)
      .default(2)
      .describe("Days between renewal billing and the payout hitting the bank (default 2)."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile for the entries. Defaults to the chosen account's profile, else the active profile."),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Preview only: fetch + plan without writing. Default false (this is the refresh path)."),
  }),
  readOnly: false,
  run: async ({ days, accountId, payoutLagDays, profile, dryRun }) => {
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

    const startedAt = Date.now();
    const fetched = await fetchProjectionSourceRenewals("recurly-api", days);
    const result = await importRecurlyRenewals(db, owner, {
      rows: fetched.rows,
      accountId: accountId ?? null,
      profile: targetProfile,
      payoutLagDays,
      dryRun,
    });

    return {
      ok: true,
      dryRun,
      days,
      activeSubscriptions: fetched.activeSubscriptions,
      renewalsInWindow: fetched.rows.length,
      skippedFree: fetched.skippedFree,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      totalProjectedCents: result.totalProjectedCents,
      totalProjected: result.totalProjectedCents / 100,
      payoutLagDays,
      accountId: accountId ?? null,
      profile: targetProfile,
      elapsedMs: Date.now() - startedAt,
    };
  },
});
