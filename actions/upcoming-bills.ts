/**
 * Projected occurrences across active recurrings over the next N days,
 * sorted by date, with per-item and total amounts.
 * Read-only. Run:  pnpm action upcoming-bills --days 14
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, paymentPlans, recurring } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { projectOccurrences, type RecurringRow } from "../server/lib/recurring.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { fundingCheckV2, nextDueDate, type OtherPlanForProjection } from "../server/lib/payment-plans.js";

export default defineAction({
  description:
    "List projected occurrences (bills, subscriptions, income, and active payment plans) across the next N days, sorted by date, with per-item and total amounts (signed cents; positive = outflow). Payment-plan items are flagged kind:'plan', critical:true (always visually prominent), warn:true only when the plan is 'at_risk' (income IS linked to the pay-from account yet the projection still falls short — a trustworthy shortfall), and include a funding check {snapshotFundedNow, projectedBalanceAtDueCents, projectedFunded, shortfallCents, payFromAccountName, projectionBasis, hasLinkedIncome, fundingStatus ('at_risk'|'unverified'|'ok')} against the pay-from account. A plan with fundingStatus:'unverified' (no income recurring linked to the pay-from account) is amber, NOT a red warn — offer to link the paycheck's accountId. Scoped to the active profile by default; pass profile:'all' to include both.",
  schema: z.object({
    days: z.coerce.number().int().min(1).max(365).default(14),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ days, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const rows = await db
      .select()
      .from(recurring)
      .where(
        effectiveProfile !== "all"
          ? and(eq(recurring.ownerEmail, owner), eq(recurring.profile, effectiveProfile))
          : eq(recurring.ownerEmail, owner),
      );
    const active = rows.filter((r) => r.isActive);

    const planRows = await db
      .select()
      .from(paymentPlans)
      .where(
        effectiveProfile !== "all"
          ? and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.profile, effectiveProfile), eq(paymentPlans.status, "active"))
          : and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.status, "active")),
      );

    const acctRows = planRows.length
      ? await db
          .select({
            id: accounts.id,
            // Display name = nickname if set, else the institution name.
            name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
            mask: accounts.mask,
            currentBalanceCents: accounts.currentBalanceCents,
          })
          .from(accounts)
          .where(eq(accounts.ownerEmail, owner))
      : [];

    // Full active-recurring set (any profile) with accountId, for funding
    // projections — a plan's pay-from account may hold recurrings scoped to
    // either profile, and projections are per-account regardless of profile.
    const allActiveRecurrings = planRows.length
      ? (
          await db
            .select()
            .from(recurring)
            .where(eq(recurring.ownerEmail, owner))
        )
          .filter((r) => r.isActive)
          .map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind as RecurringRow["kind"],
            frequency: r.frequency as RecurringRow["frequency"],
            anchorDate: r.anchorDate,
            avgAmountCents: r.avgAmountCents,
            accountId: r.accountId,
          }))
      : [];

    const fromDate = new Date().toISOString().slice(0, 10);
    const toDate = new Date(Date.now() + (days - 1) * 86_400_000).toISOString().slice(0, 10);

    const items: Array<{
      date: string;
      recurringId: string | null;
      planId?: string;
      name: string;
      kind: string;
      amountCents: number;
      critical?: boolean;
      warn?: boolean;
      funding?: ReturnType<typeof fundingCheckV2>;
    }> = [];

    for (const r of active) {
      const recurringItem: RecurringRow = {
        id: r.id,
        name: r.name,
        kind: r.kind as RecurringRow["kind"],
        frequency: r.frequency as RecurringRow["frequency"],
        anchorDate: r.anchorDate,
        avgAmountCents: r.avgAmountCents,
      };
      const occurrences = projectOccurrences(recurringItem, fromDate, toDate);
      for (const occ of occurrences) {
        items.push({ date: occ.date, recurringId: r.id, name: r.name, kind: r.kind, amountCents: occ.amountCents });
      }
    }

    for (const p of planRows) {
      const due = nextDueDate({ dueDay: p.dueDay }, fromDate);
      if (due < fromDate || due > toDate) continue;
      const otherPlans: OtherPlanForProjection[] = planRows
        .filter((op) => op.id !== p.id)
        .map((op) => ({
          id: op.id,
          name: op.name,
          dueDay: op.dueDay,
          paymentCents: op.paymentCents,
          accountId: op.payFromAccountId,
        }));
      const funding = fundingCheckV2(
        { paymentCents: p.paymentCents, payFromAccountId: p.payFromAccountId },
        acctRows.map((a) => ({
          id: a.id,
          currentBalanceCents: a.currentBalanceCents,
          name: a.name ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : null,
        })),
        { dueDate: due, recurrings: allActiveRecurrings, otherPlans },
      );
      items.push({
        date: due,
        recurringId: null,
        planId: p.id,
        name: p.name,
        kind: "plan",
        amountCents: p.paymentCents,
        critical: true,
        // warn is now the three-tier at_risk signal only (funding.warn). An
        // 'unverified' (no linked income) plan is amber, not a red warn.
        warn: funding.warn,
        funding,
      });
    }

    items.sort((a, b) => a.date.localeCompare(b.date));

    const totalCents = items.reduce((sum, i) => sum + i.amountCents, 0);
    const billsCents = items.filter((i) => i.kind !== "income").reduce((sum, i) => sum + i.amountCents, 0);
    const incomeCents = items.filter((i) => i.kind === "income").reduce((sum, i) => sum + i.amountCents, 0);

    return {
      fromDate,
      toDate,
      items: items.map((i) => ({ ...i, amount: i.amountCents / 100 })),
      totalCents,
      total: totalCents / 100,
      billsCents,
      bills: billsCents / 100,
      incomeCents,
      income: incomeCents / 100,
    };
  },
});
