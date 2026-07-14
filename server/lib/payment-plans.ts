/**
 * Deterministic core for fixed-payment credit-card/loan payoff plans
 * ("payment plans"): due-day projection, amortization schedule, payment
 * matching against real transactions, and the funding check that answers
 * "will the money be in the pay-from account by the due date." Framework-
 * light (pure functions + a matching helper that takes plain rows) so both
 * actions and tests can call it directly.
 *
 * Money is signed INTEGER cents (Plaid convention): positive = money OUT
 * (a payment leaving the pay-from account), negative = money IN.
 */
import { normalizeMerchantKey, projectOccurrences, type RecurringRow } from "./recurring.js";

export type PlanStatus = "active" | "paid_off" | "closed";

export interface PaymentPlanRow {
  id: string;
  name: string;
  cardAccountId: string | null;
  payFromAccountId: string | null;
  paymentCents: number;
  dueDay: number;
  aprBps: number | null;
  termMonths: number | null;
  startDate: string | null;
  originalBalanceCents: number | null;
  currentBalanceCents: number | null;
  merchantKey: string | null;
  status: PlanStatus;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** Clamp a day-of-month to the last valid day of that month (e.g. 31 -> 28/29/30). */
function clampDayOfMonth(year: number, month0: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

function isoDate(year: number, month0: number, day: number): string {
  return new Date(Date.UTC(year, month0, day)).toISOString().slice(0, 10);
}

/** Build the due date for a given (year, month0) using the plan's due_day, clamped. */
function dueDateInMonth(dueDay: number, year: number, month0: number): string {
  return isoDate(year, month0, clampDayOfMonth(year, month0, dueDay));
}

/** Next due date on/after `fromDate` (defaults to today, UTC), derived from due_day. */
export function nextDueDate(plan: Pick<PaymentPlanRow, "dueDay">, from?: string): string {
  const fromDate = from ?? new Date().toISOString().slice(0, 10);
  const d = new Date(`${fromDate}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month0 = d.getUTCMonth();

  const thisMonthDue = dueDateInMonth(plan.dueDay, year, month0);
  if (thisMonthDue >= fromDate) return thisMonthDue;

  const nextMonth0 = month0 + 1;
  const nextYear = year + Math.floor(nextMonth0 / 12);
  const normalizedMonth0 = ((nextMonth0 % 12) + 12) % 12;
  return dueDateInMonth(plan.dueDay, nextYear, normalizedMonth0);
}

/** Whole days between today (or fromDate) and the plan's next due date. */
export function daysUntilDue(plan: Pick<PaymentPlanRow, "dueDay">, from?: string): number {
  const fromDate = from ?? new Date().toISOString().slice(0, 10);
  return daysBetween(fromDate, nextDueDate(plan, fromDate));
}

export interface AmortizationRow {
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  balanceCents: number;
}

export interface AmortizationResult {
  rows: AmortizationRow[];
  payoffDate: string | null;
  totalInterestCents: number;
}

/**
 * Project a monthly amortization schedule from the plan's current balance,
 * apr_bps (annual, /12 for the monthly periodic rate), and fixed payment,
 * starting from the next due date. Stops early if the balance reaches zero
 * (payoff) or after `months` (defaults to term_months, or 360 as a guard).
 */
export function amortizationSchedule(
  plan: Pick<
    PaymentPlanRow,
    "dueDay" | "paymentCents" | "aprBps" | "termMonths" | "currentBalanceCents"
  >,
  months?: number,
): AmortizationResult {
  const monthlyRate = (plan.aprBps ?? 0) / 10_000 / 12;
  const horizon = months ?? plan.termMonths ?? 360;
  const rows: AmortizationRow[] = [];

  let balance = Math.max(0, plan.currentBalanceCents ?? 0);
  let cursor = nextDueDate(plan);
  let payoffDate: string | null = null;
  let totalInterestCents = 0;

  for (let i = 0; i < horizon && balance > 0; i++) {
    const interestCents = Math.round(balance * monthlyRate);
    const rawPayment = Math.min(plan.paymentCents, balance + interestCents);
    const principalCents = rawPayment - interestCents;
    balance = Math.max(0, balance - principalCents);
    totalInterestCents += interestCents;

    rows.push({
      date: cursor,
      paymentCents: rawPayment,
      interestCents,
      principalCents,
      balanceCents: balance,
    });

    if (balance === 0) {
      payoffDate = cursor;
      break;
    }

    const d = new Date(`${cursor}T00:00:00Z`);
    const year = d.getUTCFullYear();
    const nextMonth0 = d.getUTCMonth() + 1;
    const normalizedYear = year + Math.floor(nextMonth0 / 12);
    const normalizedMonth0 = ((nextMonth0 % 12) + 12) % 12;
    cursor = dueDateInMonth(plan.dueDay, normalizedYear, normalizedMonth0);
  }

  return { rows, payoffDate, totalInterestCents };
}

export interface PlanCandidateTxn {
  id: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  name: string | null;
  merchantName: string | null;
  accountId: string;
  paymentPlanId: string | null;
}

export interface MatchedPayment {
  transactionId: string;
  date: string;
  amountCents: number;
}

export interface MatchPlanPaymentsResult {
  matched: MatchedPayment[];
  newBalanceCents: number;
  paidThisMonth: boolean;
}

/** True if `amountCents` is within `toleranceFraction` (default 2%) of `targetCents`. */
function withinTolerance(amountCents: number, targetCents: number, toleranceFraction = 0.02): boolean {
  if (targetCents === 0) return amountCents === 0;
  const diff = Math.abs(Math.abs(amountCents) - Math.abs(targetCents));
  return diff <= Math.abs(targetCents) * toleranceFraction;
}

/**
 * Given a plan and a candidate set of transactions (already filtered to the
 * plan's pay-from account, or all accounts if unset), find unlinked
 * transactions that look like this plan's payment (merchant_key match if
 * set, else amount-only; amount within ±2% of payment_cents; outflow i.e.
 * positive cents) and return them as matches, plus the plan's balance after
 * applying one amortized payment per matched month (this is a projection —
 * callers persist the resulting balance and set payment_plan_id on the rows).
 */
export function matchPlanPayments(
  plan: Pick<PaymentPlanRow, "id" | "paymentCents" | "merchantKey" | "aprBps" | "currentBalanceCents" | "payFromAccountId">,
  candidates: PlanCandidateTxn[],
  today?: string,
): MatchPlanPaymentsResult {
  const monthlyRate = (plan.aprBps ?? 0) / 10_000 / 12;
  const wantKey = plan.merchantKey ? normalizeMerchantKey(plan.merchantKey) : null;

  const matches = candidates.filter((t) => {
    if (t.paymentPlanId) return false; // already linked
    if (plan.payFromAccountId && t.accountId !== plan.payFromAccountId) return false;
    if (t.amountCents <= 0) return false; // must be an outflow
    if (!withinTolerance(t.amountCents, plan.paymentCents)) return false;
    if (wantKey) {
      const txKey = normalizeMerchantKey(t.merchantName || t.name);
      if (txKey !== wantKey) return false;
    }
    return true;
  });

  matches.sort((a, b) => a.date.localeCompare(b.date));

  let balance = Math.max(0, plan.currentBalanceCents ?? 0);
  for (const m of matches) {
    const interestCents = Math.round(balance * monthlyRate);
    const principalCents = Math.max(0, m.amountCents - interestCents);
    balance = Math.max(0, balance - principalCents);
  }

  const todayIso = today ?? new Date().toISOString().slice(0, 10);
  const currentMonthPrefix = todayIso.slice(0, 7);
  const paidThisMonth = matches.some((m) => m.date.slice(0, 7) === currentMonthPrefix);

  return {
    matched: matches.map((m) => ({ transactionId: m.id, date: m.date, amountCents: m.amountCents })),
    newBalanceCents: balance,
    paidThisMonth,
  };
}

export interface FundingCheckAccount {
  id: string;
  currentBalanceCents: number | null;
}

export interface FundingCheckResult {
  funded: boolean;
  shortfallCents: number;
  payFromAccountName: string | null;
}

/**
 * "$470 in Example Bank checking by the 17th" check: does the pay-from account's
 * current balance cover the plan's payment amount? This is a simple current-
 * balance snapshot, not a projected runway — it answers "if the payment ran
 * right now, would it clear."
 */
export function fundingCheck(
  plan: Pick<PaymentPlanRow, "paymentCents" | "payFromAccountId">,
  accounts: Array<FundingCheckAccount & { name?: string | null }>,
): FundingCheckResult {
  if (!plan.payFromAccountId) {
    return { funded: false, shortfallCents: plan.paymentCents, payFromAccountName: null };
  }
  const account = accounts.find((a) => a.id === plan.payFromAccountId);
  if (!account) {
    return { funded: false, shortfallCents: plan.paymentCents, payFromAccountName: null };
  }
  const balance = account.currentBalanceCents ?? 0;
  const shortfall = Math.max(0, plan.paymentCents - balance);
  return {
    funded: shortfall === 0,
    shortfallCents: shortfall,
    payFromAccountName: account.name ?? null,
  };
}

export interface ProjectionContribution {
  date: string;
  name: string;
  amountCents: number; // signed, Plaid convention: positive = outflow, negative = inflow
  /** 'projected' = one-off projected-income ledger entry (estimate, lower confidence). */
  kind: "bill" | "subscription" | "income" | "plan" | "projected";
}

/**
 * One-off projected-income ledger entry (fp_projected_entries) as a
 * projection input. `accountId` is the account the money is expected to hit.
 */
export interface ProjectedEntryForProjection {
  id: string;
  name: string;
  /** Expected bank date, YYYY-MM-DD. */
  date: string;
  /** Signed cents (income negative). */
  amountCents: number;
  accountId: string | null;
}

export interface ProjectedAccountBalanceResult {
  projectedCents: number;
  contributions: ProjectionContribution[];
}

/**
 * Minimal shape of "another payment plan" as an input to projection — modeled
 * as a synthetic monthly bill on its own due day, same as get-runway does.
 */
export interface OtherPlanForProjection {
  id: string;
  name: string;
  dueDay: number;
  paymentCents: number;
  accountId: string | null; // the plan's pay-from account
}

/**
 * Project an account's balance forward from today to `onDate` (inclusive) by
 * starting from its current balance and applying every ACTIVE recurring item
 * (bills negative-effect/outflow, income positive-effect/inflow — Plaid sign:
 * bills/subscriptions positive cents, income negative cents) AND every OTHER
 * payment plan whose account matches this one, for occurrence dates in
 * (today, onDate]. Today's occurrences are excluded (this projects what
 * happens BETWEEN now and the due date, not a same-day double-count of an
 * already-reflected current balance).
 *
 * Items with no linked account (recurring.accountId or plan.accountId null)
 * are excluded here — they can't be attributed to a specific account for a
 * per-account projection. (The aggregate runway in get-runway still includes
 * every active recurring/plan regardless of account linkage.) Callers should
 * surface this via `projectionBasis` so the UI can hint at linking accounts.
 */
export function projectedAccountBalance(opts: {
  accountId: string;
  currentBalanceCents: number;
  onDate: string;
  today?: string;
  recurrings: Array<RecurringRow & { accountId: string | null }>;
  otherPlans?: OtherPlanForProjection[];
  /** One-off projected-income entries; only those with accountId === this account count. */
  projectedEntries?: ProjectedEntryForProjection[];
}): ProjectedAccountBalanceResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const contributions: ProjectionContribution[] = [];

  if (opts.onDate <= today) {
    return { projectedCents: opts.currentBalanceCents, contributions: [] };
  }

  // Occurrences strictly after today, up to and including onDate.
  const dayAfterToday = new Date(`${today}T00:00:00Z`);
  dayAfterToday.setUTCDate(dayAfterToday.getUTCDate() + 1);
  const fromDate = dayAfterToday.toISOString().slice(0, 10);

  let projectedCents = opts.currentBalanceCents;

  for (const r of opts.recurrings) {
    if (r.accountId !== opts.accountId) continue;
    const occurrences = fromDate <= opts.onDate ? projectOccurrences(r, fromDate, opts.onDate) : [];
    for (const occ of occurrences) {
      projectedCents -= occ.amountCents; // Plaid sign: positive=outflow reduces balance
      contributions.push({
        date: occ.date,
        name: r.name,
        amountCents: occ.amountCents,
        kind: r.kind,
      });
    }
  }

  for (const p of opts.otherPlans ?? []) {
    if (p.accountId !== opts.accountId) continue;
    const due = nextDueDate({ dueDay: p.dueDay }, fromDate);
    if (due < fromDate || due > opts.onDate) continue;
    projectedCents -= p.paymentCents;
    contributions.push({
      date: due,
      name: p.name,
      amountCents: p.paymentCents,
      kind: "plan",
    });
  }

  // One-off projected-income entries (estimates — cards fail, churn happens)
  // attributed to this account, dated in (today, onDate].
  for (const e of opts.projectedEntries ?? []) {
    if (e.accountId !== opts.accountId) continue;
    if (e.date < fromDate || e.date > opts.onDate) continue;
    projectedCents -= e.amountCents; // income negative → raises the balance
    contributions.push({
      date: e.date,
      name: e.name,
      amountCents: e.amountCents,
      kind: "projected",
    });
  }

  contributions.sort((a, b) => a.date.localeCompare(b.date));

  return { projectedCents, contributions };
}

export interface ProjectionBasis {
  incomeItems: number;
  billItems: number;
  /** One-off projected-income ledger entries counted (estimates, lower confidence). */
  projectedItems?: number;
}

/**
 * Three-tier funding confidence for a plan's pay-from account:
 *  - `'at_risk'`  (RED): we have LINKED INCOME on this account yet the
 *    projected balance at the due date still falls short. A trustworthy
 *    shortfall — the real alarm.
 *  - `'unverified'` (AMBER): no income recurring is linked to this account AND
 *    today's snapshot doesn't cover the payment. We can't trust the projection
 *    (it assumes zero income), so this is a "link your income" nudge, not an
 *    alarm.
 *  - `'ok'` (calm): the projection covers it, or the snapshot already does.
 */
export type FundingStatus = "at_risk" | "unverified" | "ok";

export interface FundingCheckV2Result {
  /** Does the pay-from account's CURRENT balance cover the payment right now? */
  snapshotFundedNow: boolean;
  /** Projected balance in the pay-from account at the plan's due date. */
  projectedBalanceAtDueCents: number;
  /** Does the PROJECTED balance at due date cover the payment? */
  projectedFunded: boolean;
  /** Shortfall vs the projected balance (0 if projectedFunded). */
  shortfallCents: number;
  payFromAccountName: string | null;
  contributions: ProjectionContribution[];
  /** Counts of income/bill items counted toward the projection, so the UI can warn when projections rest on bills-only (pessimistic) data. */
  projectionBasis: ProjectionBasis;
  /**
   * True when an ACTIVE income recurring is linked (accountId) to this plan's
   * pay-from account with an occurrence landing on/before the due date. When
   * false the projection is "bills-only" and pessimistic by construction.
   */
  hasLinkedIncome: boolean;
  /** Three-tier confidence — see FundingStatus. */
  fundingStatus: FundingStatus;
  /**
   * `warn` is now DEFINED as `fundingStatus === 'at_risk'` — the only tier that
   * should drive alarming red UI. An 'unverified' (amber) plan no longer trips
   * warn anywhere (dashboard, runway, plans, recurring).
   */
  warn: boolean;
}

/**
 * v2 funding check: combines the current-balance snapshot with a forward
 * projection to the plan's next due date, then grades confidence into three
 * tiers (see FundingStatus). The user's complaint was two-fold: (1) a plan
 * looked short on TODAY's balance even though income arrives before the due
 * date — solved by `projectedFunded`; and (2) a plan looked "at risk" purely
 * because NO income recurring was linked to the pay-from account, so the
 * projection assumed zero income arrived (over-warning on absence of
 * evidence). The `unverified` tier fixes (2): when there is no linked income
 * and the snapshot is short, we surface an amber "link your income" nudge
 * instead of a red alarm.
 */
export function fundingCheckV2(
  plan: Pick<PaymentPlanRow, "paymentCents" | "payFromAccountId">,
  accounts: Array<FundingCheckAccount & { name?: string | null }>,
  opts: {
    dueDate: string;
    today?: string;
    recurrings: Array<RecurringRow & { accountId: string | null }>;
    otherPlans?: OtherPlanForProjection[];
    /** One-off projected-income ledger entries (counted only for the pay-from account). */
    projectedEntries?: ProjectedEntryForProjection[];
  },
): FundingCheckV2Result {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const emptyBasis: ProjectionBasis = { incomeItems: 0, billItems: 0, projectedItems: 0 };

  const unresolved = (): FundingCheckV2Result => ({
    snapshotFundedNow: false,
    projectedBalanceAtDueCents: 0,
    projectedFunded: false,
    shortfallCents: plan.paymentCents,
    payFromAccountName: null,
    contributions: [],
    projectionBasis: emptyBasis,
    hasLinkedIncome: false,
    // No pay-from account (or account missing) — can't verify anything; treat
    // as 'unverified' (amber nudge), not a red alarm.
    fundingStatus: "unverified",
    warn: false,
  });

  if (!plan.payFromAccountId) return unresolved();
  const account = accounts.find((a) => a.id === plan.payFromAccountId);
  if (!account) return unresolved();

  const currentBalanceCents = account.currentBalanceCents ?? 0;
  const snapshotFundedNow = currentBalanceCents >= plan.paymentCents;

  const projection = projectedAccountBalance({
    accountId: plan.payFromAccountId,
    currentBalanceCents,
    onDate: opts.dueDate,
    today,
    recurrings: opts.recurrings,
    otherPlans: opts.otherPlans,
    projectedEntries: opts.projectedEntries,
  });

  const projectedFunded = projection.projectedCents >= plan.paymentCents;
  const shortfallCents = Math.max(0, plan.paymentCents - projection.projectedCents);

  const projectionBasis: ProjectionBasis = {
    incomeItems: projection.contributions.filter((c) => c.kind === "income").length,
    billItems: projection.contributions.filter((c) => c.kind !== "income" && c.kind !== "projected").length,
    projectedItems: projection.contributions.filter((c) => c.kind === "projected").length,
  };

  // hasLinkedIncome = any active income recurring linked to THIS pay-from
  // account whose next occurrence lands in the projection window (today, due].
  // The projection already only counts such occurrences, so incomeItems>0 is
  // exactly that signal.
  const hasLinkedIncome = projectionBasis.incomeItems > 0;

  let fundingStatus: FundingStatus;
  if (projectedFunded || snapshotFundedNow) {
    fundingStatus = "ok";
  } else if (hasLinkedIncome) {
    // Trustworthy projection that still falls short — real shortfall.
    fundingStatus = "at_risk";
  } else {
    // No income evidence and snapshot short — can't trust it; nudge, don't alarm.
    fundingStatus = "unverified";
  }

  return {
    snapshotFundedNow,
    projectedBalanceAtDueCents: projection.projectedCents,
    projectedFunded,
    shortfallCents,
    payFromAccountName: account.name ?? null,
    contributions: projection.contributions,
    projectionBasis,
    hasLinkedIncome,
    fundingStatus,
    warn: fundingStatus === "at_risk",
  };
}

/**
 * Household (cross-account) sanity layer. A plan can be paid from any account
 * in reality — money that exists in account B still covers a plan on account A,
 * it just needs a transfer. This projects the TOTAL liquid balance across every
 * active depository account (same profile) forward to the plan's due date,
 * folding in ALL income, ALL bills/subscriptions, and ALL plan payments due by
 * that date (regardless of which account they're attributed to), then answers
 * "can the household as a whole cover this plan's payment by then."
 *
 * When true, an account-level 'at_risk'/'unverified' plan can be DOWNGRADED to
 * an informational "move funds" note rather than a red alarm — the money
 * exists, it's just in the wrong account.
 */
export interface HouseholdAccount extends FundingCheckAccount {
  /** Only depository accounts contribute to household liquid balance. */
  type?: string | null;
  isActive?: boolean;
}

export interface HouseholdFundingResult {
  /** Projected total liquid (depository) balance across the household at the due date. */
  householdProjectedCents: number;
  /** Does the household projection cover this plan's payment? */
  householdCoversPayment: boolean;
}

export function householdFundingForPlan(
  plan: Pick<PaymentPlanRow, "id" | "paymentCents" | "dueDay">,
  allAccounts: HouseholdAccount[],
  allRecurrings: Array<RecurringRow & { accountId: string | null }>,
  otherPlans: OtherPlanForProjection[],
  dueDate: string,
  today?: string,
  /** One-off projected-income entries — counted household-wide regardless of account linkage. */
  projectedEntries?: ProjectedEntryForProjection[],
): HouseholdFundingResult {
  const asOfToday = today ?? new Date().toISOString().slice(0, 10);

  // Starting household liquid balance: sum of active depository accounts.
  const depository = allAccounts.filter(
    (a) => (a.isActive ?? true) && (a.type === "depository" || a.type == null),
  );
  const startingCents = depository.reduce((s, a) => s + (a.currentBalanceCents ?? 0), 0);

  if (dueDate <= asOfToday) {
    return {
      householdProjectedCents: startingCents,
      householdCoversPayment: startingCents >= plan.paymentCents,
    };
  }

  const dayAfterToday = new Date(`${asOfToday}T00:00:00Z`);
  dayAfterToday.setUTCDate(dayAfterToday.getUTCDate() + 1);
  const fromDate = dayAfterToday.toISOString().slice(0, 10);

  let projectedCents = startingCents;

  // Every active recurring — ACCOUNT LINKAGE IS IGNORED here on purpose: the
  // household aggregate models the whole balance, so income/bills count no
  // matter which (or no) account they're attributed to.
  for (const r of allRecurrings) {
    if (fromDate > dueDate) break;
    const occurrences = projectOccurrences(r, fromDate, dueDate);
    for (const occ of occurrences) {
      projectedCents -= occ.amountCents; // Plaid sign: positive=outflow reduces balance
    }
  }

  // Projected-income ledger entries count household-wide (same aggregate
  // rationale as recurrings above — the balance is one pool).
  for (const e of projectedEntries ?? []) {
    if (e.date < fromDate || e.date > dueDate) continue;
    projectedCents -= e.amountCents; // income negative → raises the balance
  }

  // Every OTHER active plan's payment due by this date (this plan's own payment
  // is the thing we're checking coverage for, so it is NOT subtracted).
  for (const p of otherPlans) {
    if (p.id === plan.id) continue;
    const due = nextDueDate({ dueDay: p.dueDay }, fromDate);
    if (due < fromDate || due > dueDate) continue;
    projectedCents -= p.paymentCents;
  }

  return {
    householdProjectedCents: projectedCents,
    householdCoversPayment: projectedCents >= plan.paymentCents,
  };
}
