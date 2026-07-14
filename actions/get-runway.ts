/**
 * Cashflow "runway" projection: starting balance (active depository accounts)
 * plus a day-by-day ledger of projected recurring bills/income (and an
 * optional flat daily variable-spend estimate) over N days.
 * Read-only. Run:  pnpm action get-runway --days 30
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, paymentPlans, recurring } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { computeRunway, type RecurringRow } from "../server/lib/recurring.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import {
  fundingCheckV2,
  householdFundingForPlan,
  nextDueDate,
  type HouseholdAccount,
  type OtherPlanForProjection,
  type ProjectedEntryForProjection,
} from "../server/lib/payment-plans.js";
import { projectedEntriesForWindow } from "../server/lib/projections.js";

export default defineAction({
  description:
    "Compute a day-by-day cashflow runway projection over the next N days: starting balance (sum of active depository account balances) plus projected recurring bills/subscriptions (outflows), income (inflows), and active payment plans (CRITICAL fixed payoff plans, flagged kind:'plan', with warn:true only for a NET red alarm — the plan is 'at_risk' AND the household can't cover it either). Returns the daily ledger, minBalanceCents/minBalanceDate (the 'pinch point'), negativeDates, planFundingWarnings (RED, at_risk with NO household coverage — a genuine shortfall where income IS linked but still falls short), and planFundingNotes (AMBER, non-alarming: plans that are 'unverified' — no income recurring linked to the pay-from account, so the projection assumes zero income and can't be trusted; offer to link the paycheck's accountId — or 'householdCovered' — money exists across the user's other accounts, just move it into the pay-from account by the due date). A plan that looks short on today's balance but has income arriving before its due date, or is only unverified/household-covered, will NOT appear in planFundingWarnings — that's by design. ALSO includes the projected-income ledger (fp_projected_entries, e.g. upcoming Recurly renewals): 'projected'-status entries land on their expected bank date as items flagged kind:'projected' with estimate:true (a confidence caveat — these are probabilistic renewals, not promises; past-due projections older than 7 days are excluded automatically). The summary includes projectedIncomeCents (total projected income counted in the window), and planProjectedIncomeNotes lists plans whose funding coverage RELIES on projected income arriving ('relies on $X projected renewals'). Scoped to the active profile by default (both accounts and recurrings/plans); pass profile:'all' to combine personal+business cashflow. Use for cashflow questions ('will I have enough to cover rent', 'when's my lowest balance').",
  schema: z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    dailyVariableSpendCents: z
      .coerce.number()
      .int()
      .min(0)
      .optional()
      .describe("Optional flat estimated non-recurring daily spend (cents) to subtract each day."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ days, dailyVariableSpendCents, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
        currentBalanceCents: accounts.currentBalanceCents,
        type: accounts.type,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .where(
        effectiveProfile !== "all"
          ? and(eq(accounts.ownerEmail, owner), eq(accounts.profile, effectiveProfile))
          : eq(accounts.ownerEmail, owner),
      );

    const recRows = await db
      .select()
      .from(recurring)
      .where(
        effectiveProfile !== "all"
          ? and(eq(recurring.ownerEmail, owner), eq(recurring.profile, effectiveProfile))
          : eq(recurring.ownerEmail, owner),
      );
    const activeRecurrings: RecurringRow[] = recRows
      .filter((r) => r.isActive)
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind as RecurringRow["kind"],
        frequency: r.frequency as RecurringRow["frequency"],
        anchorDate: r.anchorDate,
        avgAmountCents: r.avgAmountCents,
      }));
    // Same rows, but carrying accountId — used only for per-account funding
    // projections below (computeRunway's RecurringRow doesn't need accountId).
    const activeRecurringsWithAccount = recRows
      .filter((r) => r.isActive)
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind as RecurringRow["kind"],
        frequency: r.frequency as RecurringRow["frequency"],
        anchorDate: r.anchorDate,
        avgAmountCents: r.avgAmountCents,
        accountId: r.accountId,
      }));

    const planRows = await db
      .select()
      .from(paymentPlans)
      .where(
        effectiveProfile !== "all"
          ? and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.profile, effectiveProfile), eq(paymentPlans.status, "active"))
          : and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.status, "active")),
      );

    // Model each active plan as a synthetic monthly "recurring" so it shows up
    // in the day-by-day ledger like a bill, flagged kind:'plan' downstream.
    const planAsRecurring: RecurringRow[] = planRows.map((p) => ({
      id: `plan:${p.id}`,
      name: p.name,
      kind: "bill",
      frequency: "monthly",
      anchorDate: nextDueDate({ dueDay: p.dueDay }),
      avgAmountCents: p.paymentCents,
    }));

    // Projected-income ledger (e.g. upcoming Recurly renewals): 'projected'
    // rows only, stale past-due ones auto-excluded. Fetch a wide window (400d)
    // so plan due dates beyond the runway horizon are covered too;
    // computeRunway clips to its own horizon.
    const today = new Date().toISOString().slice(0, 10);
    const wideEnd = new Date(`${today}T00:00:00Z`);
    wideEnd.setUTCDate(wideEnd.getUTCDate() + 400);
    const projEntries = await projectedEntriesForWindow(db, owner, effectiveProfile, {
      from: today,
      to: wideEnd.toISOString().slice(0, 10),
    });
    const projForProjection: ProjectedEntryForProjection[] = projEntries.map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      amountCents: e.amountCents,
      accountId: e.accountId,
    }));

    const result = computeRunway({
      accounts: acctRows,
      recurrings: [...activeRecurrings, ...planAsRecurring],
      days,
      dailyVariableSpendCents,
      projectedEntries: projEntries.map((e) => ({
        id: e.id,
        name: e.name,
        date: e.date,
        amountCents: e.amountCents,
      })),
    });

    // Total projected income actually counted inside THIS runway horizon.
    const horizonEnd = new Date(`${today}T00:00:00Z`);
    horizonEnd.setUTCDate(horizonEnd.getUTCDate() + days - 1);
    const horizonEndIso = horizonEnd.toISOString().slice(0, 10);
    const projectedIncomeCents = projEntries
      .filter((e) => e.amountCents < 0 && e.date <= horizonEndIso)
      .reduce((s, e) => s + Math.abs(e.amountCents), 0);

    // Per-plan projected funding: is the pay-from account's PROJECTED balance
    // at THIS plan's own due date enough to cover it? Other active plans on
    // the same account are folded into the projection too. Then the household
    // (cross-account) layer downgrades an account-level shortfall to a "move
    // funds" note when money exists elsewhere in the same profile.
    const allPlansForHousehold: OtherPlanForProjection[] = planRows.map((op) => ({
      id: op.id,
      name: op.name,
      dueDay: op.dueDay,
      paymentCents: op.paymentCents,
      accountId: op.payFromAccountId,
    }));
    const planFundingById = new Map(
      planRows.map((p) => {
        const dueDate = nextDueDate({ dueDay: p.dueDay }, undefined);
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
          {
            dueDate,
            recurrings: activeRecurringsWithAccount,
            otherPlans,
            projectedEntries: projForProjection,
          },
        );
        // Household accounts are the runway's own account set (already scoped to
        // the effective profile above), restricted to depository below.
        const householdAccounts: HouseholdAccount[] = acctRows.map((a) => ({
          id: a.id,
          currentBalanceCents: a.currentBalanceCents,
          type: a.type,
          isActive: a.isActive,
        }));
        const household = householdFundingForPlan(
          { id: p.id, paymentCents: p.paymentCents, dueDay: p.dueDay },
          householdAccounts,
          activeRecurringsWithAccount,
          allPlansForHousehold,
          dueDate,
          undefined,
          projForProjection,
        );
        const householdCovered = funding.fundingStatus !== "ok" && household.householdCoversPayment;
        // Net severity: red only when at_risk AND household can't cover.
        const netWarn = funding.warn && !householdCovered;
        return [p.id, { plan: p, funding, dueDate, household, householdCovered, netWarn }];
      }),
    );

    // Only true red alarms (at_risk, no household coverage) surface as warnings.
    const planFundingWarnings = Array.from(planFundingById.values())
      .filter(({ netWarn }) => netWarn)
      .map(({ plan: p, funding, dueDate, household }) => ({
        planId: p.id,
        name: p.name,
        nextDueDate: dueDate,
        paymentCents: p.paymentCents,
        projectedBalanceAtDueCents: funding.projectedBalanceAtDueCents,
        shortfallCents: funding.shortfallCents,
        payFromAccountName: funding.payFromAccountName,
        projectionBasis: funding.projectionBasis,
        fundingStatus: funding.fundingStatus,
        hasLinkedIncome: funding.hasLinkedIncome,
        householdCovered: false,
        householdProjectedCents: household.householdProjectedCents,
      }));

    return {
      startingBalanceCents: result.startingBalanceCents,
      startingBalance: result.startingBalanceCents / 100,
      days: result.days.map((d) => ({
        date: d.date,
        items: d.items.map((i) => {
          const isPlan = i.recurringId.startsWith("plan:");
          const isProjected = i.recurringId.startsWith("projected:");
          const planId = isPlan ? i.recurringId.slice(5) : undefined;
          const projectedId = isProjected ? i.recurringId.slice(10) : undefined;
          return {
            ...i,
            amount: i.amountCents / 100,
            kind: isPlan ? "plan" : i.kind,
            critical: isPlan ? true : undefined,
            // warn: true only for a NET red alarm (at_risk AND the household
            // can't cover it) — the signal that should drive alarming UI. An
            // unverified or household-covered plan stays critical (always
            // prominent) but amber, not red.
            warn: isPlan && planId ? (planFundingById.get(planId)?.netWarn ?? false) : undefined,
            // Projected-income ledger entries are ESTIMATES (probabilistic
            // renewals) — flag them so the UI renders them ghosted/caveated.
            estimate: isProjected ? true : undefined,
            recurringId: isPlan || isProjected ? null : i.recurringId,
            planId,
            projectedId,
          };
        }),
        netCents: d.netCents,
        net: d.netCents / 100,
        balanceCents: d.balanceCents,
        balance: d.balanceCents / 100,
      })),
      minBalanceCents: result.minBalanceCents,
      minBalance: result.minBalanceCents / 100,
      minBalanceDate: result.minBalanceDate,
      negativeDates: result.negativeDates,
      // Total projected-income ledger inflow counted in this window (estimates
      // — expected renewals, not promises).
      projectedIncomeCents,
      projectedIncome: projectedIncomeCents / 100,
      projectedEntryCount: projEntries.filter((e) => e.date <= horizonEndIso).length,
      // Plans whose funding coverage RELIES on projected income arriving:
      // projected-funded WITH the projected entries counted, but short without
      // them. Informational caveat ("relies on $X projected renewals"), not red.
      planProjectedIncomeNotes: Array.from(planFundingById.values())
        .map(({ plan: p, funding, dueDate }) => {
          const projContribs = funding.contributions.filter((c) => c.kind === "projected");
          if (projContribs.length === 0) return null;
          const projSumCents = projContribs.reduce((s, c) => s + c.amountCents, 0); // negative
          const balanceWithoutProjected = funding.projectedBalanceAtDueCents + projSumCents;
          if (!funding.projectedFunded || balanceWithoutProjected >= p.paymentCents) return null;
          return {
            planId: p.id,
            name: p.name,
            nextDueDate: dueDate,
            paymentCents: p.paymentCents,
            projectedIncomeCents: Math.abs(projSumCents),
            payFromAccountName: funding.payFromAccountName,
          };
        })
        .filter((n): n is NonNullable<typeof n> => n !== null),
      planFundingWarnings,
      // Non-red informational notes (amber): plans that are 'unverified' (no
      // linked income — nudge to link a paycheck) or 'householdCovered' (money
      // exists across accounts, move it into the pay-from account). These are
      // deliberately NOT in planFundingWarnings (which stays red-only).
      planFundingNotes: Array.from(planFundingById.values())
        .filter(({ funding, householdCovered }) => householdCovered || (funding.fundingStatus === "unverified" && !householdCovered))
        .map(({ plan: p, funding, dueDate, household, householdCovered }) => ({
          planId: p.id,
          name: p.name,
          nextDueDate: dueDate,
          paymentCents: p.paymentCents,
          projectedBalanceAtDueCents: funding.projectedBalanceAtDueCents,
          payFromAccountName: funding.payFromAccountName,
          fundingStatus: funding.fundingStatus,
          hasLinkedIncome: funding.hasLinkedIncome,
          householdCovered,
          householdProjectedCents: household.householdProjectedCents,
        })),
    };
  },
});
