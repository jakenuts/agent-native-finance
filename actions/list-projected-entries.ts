/**
 * List projected-income ledger entries (fp_projected_entries) — the
 * Quicken-style scheduled ledger of expected-but-not-yet-received cash
 * events (Recurly renewal imports + manual entries). Backs /projections.
 * Read-only. Run:  pnpm action list-projected-entries
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, projectedEntries } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { STALE_PROJECTION_DAYS } from "../server/lib/projections.js";

export default defineAction({
  description:
    "List projected-income ledger entries (expected future cash events — e.g. upcoming Recurly subscription renewals and manual 'we expect $X on the 15th' entries). These are ESTIMATES, not promises. Each row: date (expected BANK date), amountCents (signed, income NEGATIVE), name, source ('manual'|'recurly-import'|'api'), status ('projected'|'received'|'missed'|'canceled'), accountId + joined account name, notes, metadata. Rows also carry pastDue (a 'projected' row whose date already passed) and staleExcluded (past due > 7 days — automatically EXCLUDED from runway math until resolved; use resolve-stale-projections or update-projected-entry). Totals: next30dProjectedIncomeCents (upcoming 30-day projected income) and windowProjectedIncomeCents. Filters: from/to (date range), accountId, status, profile ('all' to combine). Scoped to the active profile by default.",
  schema: z.object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Inclusive start date (YYYY-MM-DD)."),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Inclusive end date (YYYY-MM-DD)."),
    accountId: z.string().optional(),
    status: z.enum(["projected", "received", "missed", "canceled"]).optional(),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ from, to, accountId, status, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const conditions = [eq(projectedEntries.ownerEmail, owner)];
    if (effectiveProfile !== "all") conditions.push(eq(projectedEntries.profile, effectiveProfile));
    if (from) conditions.push(gte(projectedEntries.date, from));
    if (to) conditions.push(lte(projectedEntries.date, to));
    if (accountId) conditions.push(eq(projectedEntries.accountId, accountId));
    if (status) conditions.push(eq(projectedEntries.status, status));

    const rows = await db
      .select()
      .from(projectedEntries)
      .where(and(...conditions));

    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
      })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    const acctById = new Map(acctRows.map((a) => [a.id, a]));

    const today = new Date().toISOString().slice(0, 10);
    const staleCutoff = new Date(`${today}T00:00:00Z`);
    staleCutoff.setUTCDate(staleCutoff.getUTCDate() - STALE_PROJECTION_DAYS);
    const staleCutoffIso = staleCutoff.toISOString().slice(0, 10);

    const entries = rows
      .map((r) => {
        const acct = r.accountId ? acctById.get(r.accountId) : undefined;
        const pastDue = r.status === "projected" && r.date < today;
        let metadata: unknown = null;
        if (r.metadata) {
          try {
            metadata = JSON.parse(r.metadata);
          } catch {
            metadata = null;
          }
        }
        return {
          id: r.id,
          date: r.date,
          name: r.name,
          amountCents: r.amountCents,
          amount: r.amountCents / 100,
          source: r.source,
          status: r.status,
          accountId: r.accountId,
          accountName: acct
            ? `${acct.name ?? "Account"}${acct.mask ? ` ••${acct.mask}` : ""}`
            : null,
          notes: r.notes,
          externalKey: r.externalKey,
          metadata,
          profile: r.profile,
          pastDue,
          /** Past due beyond the stale window — no longer counted by runway. */
          staleExcluded: pastDue && r.date < staleCutoffIso,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

    const in30 = new Date(`${today}T00:00:00Z`);
    in30.setUTCDate(in30.getUTCDate() + 30);
    const in30Iso = in30.toISOString().slice(0, 10);

    const next30dProjectedIncomeCents = entries
      .filter((e) => e.status === "projected" && e.amountCents < 0 && e.date >= today && e.date <= in30Iso)
      .reduce((s, e) => s + Math.abs(e.amountCents), 0);
    const windowProjectedIncomeCents = entries
      .filter((e) => e.status === "projected" && e.amountCents < 0)
      .reduce((s, e) => s + Math.abs(e.amountCents), 0);
    const pastDueCount = entries.filter((e) => e.pastDue).length;

    return {
      entries,
      count: entries.length,
      pastDueCount,
      next30dProjectedIncomeCents,
      next30dProjectedIncome: next30dProjectedIncomeCents / 100,
      windowProjectedIncomeCents,
      windowProjectedIncome: windowProjectedIncomeCents / 100,
      profile: effectiveProfile,
    };
  },
});
