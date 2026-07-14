/**
 * List payment plans for the current owner with computed fields: nextDueDate,
 * daysUntil, paidThisMonth, remainingPayments, projectedPayoffDate, funding
 * (snapshot vs PROJECTED balance at the due date), warn, and balance.
 * Read-only. Run:  pnpm action list-payment-plans
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, paymentPlans, recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import {
  amortizationSchedule,
  daysUntilDue,
  fundingCheckV2,
  householdFundingForPlan,
  matchPlanPayments,
  nextDueDate,
  type HouseholdAccount,
  type OtherPlanForProjection,
  type PaymentPlanRow,
} from "../server/lib/payment-plans.js";
import type { RecurringRow } from "../server/lib/recurring.js";

export default defineAction({
  description:
    "List payment plans (fixed credit-card/loan payoff plans) for the current owner. Each row includes computed nextDueDate, daysUntil, paidThisMonth, remainingPayments, projectedPayoffDate, current balance, warn (NET severity — true ONLY for a real red alarm: funding.fundingStatus==='at_risk' AND the household can't cover it either), householdCovered (money exists across the user's other accounts, just not in the pay-from account — a 'move funds' note, not an alarm), and funding {snapshotFundedNow, projectedBalanceAtDueCents, projectedFunded, shortfallCents, payFromAccountName, contributions, projectionBasis {incomeItems, billItems}, hasLinkedIncome, fundingStatus, householdCovered, householdProjectedCents}. THREE-TIER fundingStatus: 'at_risk' (RED) = income IS linked to the pay-from account yet the projection still falls short (trustworthy shortfall); 'unverified' (AMBER) = NO income recurring is linked to the pay-from account and the snapshot is short, so the projection assumes zero income and can't be trusted — this is a 'link your income' nudge, NOT an alarm; 'ok' (calm) = projection or snapshot covers it. When fundingStatus is 'unverified', OFFER TO LINK the user's paycheck income recurring's accountId to the pay-from account (update-recurring {id, accountId}) rather than warning. householdCovered downgrades an at_risk/unverified plan to amber 'move funds to <account> by <date>'. Only warn:true (at_risk AND no household coverage) is a genuine warning. These are CRITICAL never-miss bills regardless of funding status. Scoped to the active profile by default; pass profile:'all' to see both.",
  schema: z.object({
    status: z.enum(["active", "paid_off", "closed", "all"]).default("active").describe("Filter by status; 'all' returns every status."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ status, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const conditions = [eq(paymentPlans.ownerEmail, owner)];
    if (status !== "all") conditions.push(eq(paymentPlans.status, status));
    if (effectiveProfile !== "all") conditions.push(eq(paymentPlans.profile, effectiveProfile));

    const plans = await db
      .select()
      .from(paymentPlans)
      .where(and(...conditions));

    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
        currentBalanceCents: accounts.currentBalanceCents,
        type: accounts.type,
        isActive: accounts.isActive,
        profile: accounts.profile,
      })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    const acctById = new Map(acctRows.map((a) => [a.id, a]));

    // Projection context: every active recurring (any profile — projections
    // are per-account, and an account only belongs to one profile anyway) and
    // every OTHER active plan, so projectedAccountBalance can fold in income/
    // bills/other-plan payments that share the same pay-from account.
    const recRows = await db
      .select()
      .from(recurring)
      .where(and(eq(recurring.ownerEmail, owner), eq(recurring.isActive, true)));
    const activeRecurrings: Array<RecurringRow & { accountId: string | null }> = recRows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as RecurringRow["kind"],
      frequency: r.frequency as RecurringRow["frequency"],
      anchorDate: r.anchorDate,
      avgAmountCents: r.avgAmountCents,
      accountId: r.accountId,
    }));

    const allActivePlans = await db
      .select()
      .from(paymentPlans)
      .where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.status, "active")));

    const today = new Date().toISOString().slice(0, 10);

    const mapped = await Promise.all(
      plans.map(async (p) => {
        const planRow: Pick<PaymentPlanRow, "dueDay" | "paymentCents" | "aprBps" | "termMonths" | "currentBalanceCents"> = {
          dueDay: p.dueDay,
          paymentCents: p.paymentCents,
          aprBps: p.aprBps,
          termMonths: p.termMonths,
          currentBalanceCents: p.currentBalanceCents,
        };

        // Recent transactions on the pay-from account (or all, if unset) to
        // compute paidThisMonth without persisting a match here (list is
        // read-only; match-plan-payments is the mutating counterpart).
        const txConditions = [eq(transactions.ownerEmail, owner)];
        if (p.payFromAccountId) txConditions.push(eq(transactions.accountId, p.payFromAccountId));
        const recentTxns = p.merchantKey || p.payFromAccountId
          ? await db
              .select({
                id: transactions.id,
                date: transactions.date,
                amountCents: transactions.amountCents,
                name: transactions.name,
                merchantName: transactions.merchantName,
                accountId: transactions.accountId,
                paymentPlanId: transactions.paymentPlanId,
              })
              .from(transactions)
              .where(and(...txConditions))
          : [];

        const matchResult = matchPlanPayments(
          {
            id: p.id,
            paymentCents: p.paymentCents,
            merchantKey: p.merchantKey,
            aprBps: p.aprBps,
            currentBalanceCents: p.currentBalanceCents,
            payFromAccountId: p.payFromAccountId,
          },
          recentTxns.map((t) => ({
            id: t.id,
            date: t.date ?? "",
            amountCents: t.amountCents,
            name: t.name,
            merchantName: t.merchantName,
            accountId: t.accountId,
            paymentPlanId: t.paymentPlanId,
          })),
          today,
        );

        const amortization = amortizationSchedule(planRow);
        const payFromAccount = p.payFromAccountId ? acctById.get(p.payFromAccountId) : undefined;
        const dueDate = nextDueDate({ dueDay: p.dueDay }, today);
        const otherPlans: OtherPlanForProjection[] = allActivePlans
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
          acctRows.map((a) => ({ id: a.id, currentBalanceCents: a.currentBalanceCents, name: a.name ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : null })),
          { dueDate, today, recurrings: activeRecurrings, otherPlans },
        );

        // Household (cross-account) sanity layer: money in ANY depository
        // account of the same profile can cover this plan (with a transfer).
        // Scope household accounts to the plan's own profile so personal money
        // doesn't "cover" a business plan and vice versa.
        const householdAccounts: HouseholdAccount[] = acctRows
          .filter((a) => a.profile === p.profile)
          .map((a) => ({
            id: a.id,
            currentBalanceCents: a.currentBalanceCents,
            type: a.type,
            isActive: a.isActive,
          }));
        const allPlansForHousehold: OtherPlanForProjection[] = allActivePlans.map((op) => ({
          id: op.id,
          name: op.name,
          dueDay: op.dueDay,
          paymentCents: op.paymentCents,
          accountId: op.payFromAccountId,
        }));
        const household = householdFundingForPlan(
          { id: p.id, paymentCents: p.paymentCents, dueDay: p.dueDay },
          householdAccounts,
          activeRecurrings,
          allPlansForHousehold,
          dueDate,
          today,
        );
        // Downgrade: an account-level at_risk/unverified plan whose household
        // CAN cover it is not a true red — it's a "move funds" note.
        const householdCovered =
          funding.fundingStatus !== "ok" && household.householdCoversPayment;
        // Net severity for the UI: red only when the plan is at_risk AND the
        // household can't cover it either.
        const netWarn = funding.warn && !householdCovered;

        const paymentsMade =
          p.originalBalanceCents != null && p.termMonths
            ? Math.min(
                p.termMonths,
                Math.round(
                  ((p.originalBalanceCents - (p.currentBalanceCents ?? p.originalBalanceCents)) /
                    Math.max(1, p.originalBalanceCents)) *
                    p.termMonths,
                ),
              )
            : null;

        return {
          id: p.id,
          name: p.name,
          cardAccountId: p.cardAccountId,
          payFromAccountId: p.payFromAccountId,
          payFromAccountName: payFromAccount
            ? `${payFromAccount.name ?? "Account"}${payFromAccount.mask ? ` ••${payFromAccount.mask}` : ""}`
            : null,
          paymentCents: p.paymentCents,
          payment: p.paymentCents / 100,
          dueDay: p.dueDay,
          aprBps: p.aprBps,
          apr: p.aprBps != null ? p.aprBps / 100 : null,
          termMonths: p.termMonths,
          startDate: p.startDate,
          originalBalanceCents: p.originalBalanceCents,
          currentBalanceCents: p.currentBalanceCents,
          currentBalance: (p.currentBalanceCents ?? 0) / 100,
          merchantKey: p.merchantKey,
          status: p.status,
          notes: p.notes,
          profile: p.profile,
          nextDueDate: nextDueDate({ dueDay: p.dueDay }, today),
          daysUntil: daysUntilDue({ dueDay: p.dueDay }, today),
          critical: true,
          paidThisMonth: matchResult.paidThisMonth,
          remainingPayments:
            paymentsMade != null && p.termMonths ? Math.max(0, p.termMonths - paymentsMade) : null,
          paymentsMade,
          projectedPayoffDate: amortization.payoffDate,
          // `warn` is the "should the UI show a big red alert" signal. It is
          // now the NET severity: the account-level shortfall is a real alarm
          // (at_risk) AND the household can't cover it either. An 'unverified'
          // (no linked income) or a household-covered plan is amber, not red.
          // Plans stay visually prominent (critical: true) regardless.
          warn: netWarn,
          householdProjectedCents: household.householdProjectedCents,
          householdCoversPayment: household.householdCoversPayment,
          householdCovered,
          funding: {
            ...funding,
            householdCovered,
            householdProjectedCents: household.householdProjectedCents,
            // Back-compat alias: some older callers/UI read `funding.funded`.
            // It now means the same thing as `projectedFunded` (the
            // forward-looking signal), not the old snapshot-only meaning.
            funded: funding.projectedFunded,
          },
        };
      }),
    );

    mapped.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));

    return { plans: mapped };
  },
});
