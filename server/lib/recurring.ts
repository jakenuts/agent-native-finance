/**
 * Deterministic core for the recurring-bills engine and the runway cashflow
 * projection. Framework-light (pure functions over plain data) so both
 * actions and tests can call it directly.
 *
 * Money is signed INTEGER cents (Plaid convention): positive = money OUT
 * (spending/bills), negative = money IN (income/refund).
 */

export type RecurringKind = "bill" | "subscription" | "income";
export type RecurringFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
export type Confidence = "high" | "medium" | "low";

/** Frequency -> nominal period length in days, used for cadence matching. */
const FREQUENCY_DAYS: Record<RecurringFrequency, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.4, // average; day-of-month clamped on projection
  quarterly: 91.3,
  yearly: 365.25,
};

const TOLERANCE = 0.2; // ±20%

/**
 * Normalize a raw transaction name/merchant into a stable match key:
 * lowercase, strip store numbers, dates, trailing digits, and punctuation.
 * "CORNER MARKET #2" -> "cornermarket", "AMAZON.COM*AB12CD" -> "amazoncomab12cd" (caller
 * should prefer merchantName over name when available for cleaner keys).
 */
export function normalizeMerchantKey(name: string | null | undefined): string {
  if (!name) return "";
  let s = name.toLowerCase();
  // Strip common store/reference number patterns: "#123", "no. 456", trailing digits.
  s = s.replace(/#\s*\d+/g, " ");
  s = s.replace(/\bno\.?\s*\d+/g, " ");
  // Strip date-like fragments (MM/DD, MM-DD-YYYY, etc.).
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, " ");
  // Strip masked-card-number tokens (e.g. "3861xxxxxxxxxx9093", "xxxxxxxxxx4084")
  // entirely: a mixed digit+long-x-run token is a masked PAN, which changes on
  // card reissue for the SAME underlying subscription/merchant relationship —
  // unlike a plain digit run (already stripped above), a literal run of x's
  // survives the next [^a-z] strip below, so two card-replacement variants of
  // the same charge would otherwise normalize to DIFFERENT keys ("...xx9093"
  // vs "...xx4084" have different x-run lengths). Drop the whole token when it
  // has both a digit and an x-run of 4+ (a real short account ref like "x0681"
  // has no long x-run and is preserved by looseNormalizePreservingDigits below).
  s = s.replace(/[a-z0-9]*\d[a-z0-9]*x{4,}[a-z0-9]*|[a-z0-9]*x{4,}[a-z0-9]*\d[a-z0-9]*/g, " ");
  // Strip anything that isn't a letter or space (drops digits, punctuation, symbols).
  s = s.replace(/[^a-z\s]/g, " ");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Drop a small set of generic trailing tokens that don't identify the merchant.
  s = s.replace(/\s+(inc|llc|corp|co|ltd)$/g, "");
  return s.replace(/\s+/g, "");
}

export interface RecurringCandidateTxn {
  id: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  name: string | null;
  merchantName: string | null;
}

export interface RecurringCandidate {
  merchantKey: string;
  suggestedName: string;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  avgAmountCents: number;
  lastAmountCents: number;
  lastDate: string;
  nextDueDate: string;
  confidence: Confidence;
  occurrenceCount: number;
  evidenceTxnIds: string[];
  cadenceDescription: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianAbsoluteDeviation(values: number[], med: number): number {
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

/** Map a median gap (in days) to the closest supported frequency within ±20% tolerance. */
function frequencyForGap(gapDays: number): RecurringFrequency | null {
  let best: RecurringFrequency | null = null;
  let bestDelta = Infinity;
  for (const [freq, nominal] of Object.entries(FREQUENCY_DAYS) as Array<
    [RecurringFrequency, number]
  >) {
    const delta = Math.abs(gapDays - nominal) / nominal;
    if (delta <= TOLERANCE && delta < bestDelta) {
      best = freq;
      bestDelta = delta;
    }
  }
  return best;
}

/** Best-effort display name: the most common raw merchant/name among evidence. */
function displayName(rawNames: string[]): string {
  // Prefer the most common raw name among evidence transactions.
  const counts = new Map<string, number>();
  for (const n of rawNames) {
    const trimmed = n.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best || "Unknown merchant";
}

/**
 * Detect recurring candidates from a flat list of transactions (already
 * filtered to one owner and excluding rows already linked to a recurring).
 * NEVER creates anything — pure analysis.
 */
export function detectRecurringCandidates(
  txns: RecurringCandidateTxn[],
): RecurringCandidate[] {
  const groups = new Map<string, RecurringCandidateTxn[]>();
  for (const t of txns) {
    const key = normalizeMerchantKey(t.merchantName || t.name);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const candidates: RecurringCandidate[] = [];

  for (const [merchantKey, group] of groups) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    }
    const gapMedian = median(gaps);
    const frequency = frequencyForGap(gapMedian);
    if (!frequency) continue; // inconsistent cadence — not recurring

    const amounts = sorted.map((t) => t.amountCents);
    const amountMedian = median(amounts);
    const mad = medianAbsoluteDeviation(amounts, amountMedian);
    const amountVariable = Math.abs(amountMedian) > 0 && mad / Math.abs(amountMedian) > 0.15;

    const last = sorted[sorted.length - 1];
    const avgAmountCents = Math.round(amountMedian);

    // Plaid sign: negative = money in. Consistent negative amounts => income.
    const isIncome = amounts.every((a) => a < 0);
    let kind: RecurringKind;
    if (isIncome) {
      kind = "income";
    } else if (!amountVariable && Math.abs(avgAmountCents) < 10_000) {
      kind = "subscription";
    } else {
      kind = "bill";
    }

    // Confidence: more occurrences + tighter cadence + stable amount = higher.
    const gapToleranceRatio =
      gaps.length > 0
        ? Math.max(...gaps.map((g) => Math.abs(g - gapMedian) / Math.max(gapMedian, 1)))
        : 1;
    let confidence: Confidence;
    if (sorted.length >= 5 && gapToleranceRatio <= 0.15 && !amountVariable) {
      confidence = "high";
    } else if (sorted.length >= 4 && gapToleranceRatio <= TOLERANCE) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    const nextDueDate = addDays(last.date, FREQUENCY_DAYS[frequency]);
    const rawNames = sorted.map((t) => t.merchantName || t.name || "").filter(Boolean);

    candidates.push({
      merchantKey,
      suggestedName: displayName(rawNames),
      kind,
      frequency,
      avgAmountCents,
      lastAmountCents: last.amountCents,
      lastDate: last.date,
      nextDueDate,
      confidence,
      occurrenceCount: sorted.length,
      evidenceTxnIds: sorted.map((t) => t.id),
      cadenceDescription: `${sorted.length} charge${sorted.length === 1 ? "" : "s"}, ~${frequency}, avg $${(Math.abs(avgAmountCents) / 100).toFixed(2)}`,
    });
  }

  // Highest confidence, then most occurrences, first.
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.occurrenceCount - a.occurrenceCount);
  return candidates;
}

export interface RecurringRow {
  id: string;
  name: string;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  anchorDate: string | null;
  avgAmountCents: number | null;
}

/** Occurrences-per-year for each frequency, used to normalize to a monthly cost. */
const OCCURRENCES_PER_YEAR: Record<RecurringFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};

/** Frequency-normalized monthly cost (signed cents; positive = outflow). */
export function monthlyizedAmountCents(
  amountCents: number | null | undefined,
  frequency: RecurringFrequency,
): number {
  if (!amountCents) return 0;
  return Math.round((amountCents * OCCURRENCES_PER_YEAR[frequency]) / 12);
}

/** Next occurrence on/after `fromDate` (defaults to today, UTC), derived from anchorDate. */
export function nextDueDateFrom(
  recurringItem: RecurringRow,
  fromDate?: string,
): string | null {
  if (!recurringItem.anchorDate) return null;
  const from = fromDate ?? new Date().toISOString().slice(0, 10);
  // Look ahead up to a bit over a year to guarantee at least one occurrence.
  const horizon = addDays(from, 400);
  const occurrences = projectOccurrences(recurringItem, from, horizon);
  return occurrences.length > 0 ? occurrences[0].date : null;
}

/** Whole days between today (or fromDate) and a future date (can be negative if past). */
export function daysUntil(date: string, fromDate?: string): number {
  const from = fromDate ?? new Date().toISOString().slice(0, 10);
  return daysBetween(from, date);
}

export interface ProjectedOccurrence {
  date: string;
  amountCents: number;
}

/** Clamp a day-of-month to the last valid day of that month (e.g. 31 -> 28/29/30). */
function clampDayOfMonth(year: number, month0: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

function addMonthsClamped(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  const targetMonth0 = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(targetMonth0 / 12);
  const month0 = ((targetMonth0 % 12) + 12) % 12;
  const clampedDay = clampDayOfMonth(year, month0, day);
  return new Date(Date.UTC(year, month0, clampedDay)).toISOString().slice(0, 10);
}

/**
 * Project future occurrence dates + amounts for a recurring item between
 * fromDate and toDate (inclusive), derived from anchorDate + frequency.
 * Day-of-month is clamped for short months (monthly/quarterly/yearly).
 */
export function projectOccurrences(
  recurringItem: RecurringRow,
  fromDate: string,
  toDate: string,
): ProjectedOccurrence[] {
  const anchor = recurringItem.anchorDate;
  if (!anchor) return [];
  const amountCents = recurringItem.avgAmountCents ?? 0;
  const out: ProjectedOccurrence[] = [];

  if (recurringItem.frequency === "weekly" || recurringItem.frequency === "biweekly") {
    const stepDays = recurringItem.frequency === "weekly" ? 7 : 14;
    // Find the first occurrence >= fromDate by stepping from the anchor.
    let cursor = anchor;
    if (cursor < fromDate) {
      const gap = daysBetween(cursor, fromDate);
      const steps = Math.floor(gap / stepDays);
      cursor = addDays(cursor, steps * stepDays);
      while (cursor < fromDate) cursor = addDays(cursor, stepDays);
    }
    while (cursor <= toDate) {
      if (cursor >= fromDate) out.push({ date: cursor, amountCents });
      cursor = addDays(cursor, stepDays);
    }
    return out;
  }

  const stepMonths =
    recurringItem.frequency === "monthly" ? 1 : recurringItem.frequency === "quarterly" ? 3 : 12;
  let cursor = anchor;
  if (cursor < fromDate) {
    // Advance in month-steps until we reach or pass fromDate.
    let guard = 0;
    while (cursor < fromDate && guard < 2000) {
      cursor = addMonthsClamped(cursor, stepMonths);
      guard++;
    }
  }
  let guard = 0;
  while (cursor <= toDate && guard < 2000) {
    if (cursor >= fromDate) out.push({ date: cursor, amountCents });
    cursor = addMonthsClamped(cursor, stepMonths);
    guard++;
  }
  return out;
}

export interface RunwayAccount {
  id: string;
  currentBalanceCents: number | null;
  type: string | null;
  isActive: boolean;
}

export interface RunwayDayItem {
  recurringId: string;
  name: string;
  /** 'projected' = a one-off projected-income ledger entry (estimate, not a promise). */
  kind: RecurringKind | "projected";
  amountCents: number;
}

/** One-off dated projected entry (fp_projected_entries) folded into the runway. */
export interface RunwayProjectedEntry {
  id: string;
  name: string;
  /** Expected bank date, YYYY-MM-DD. */
  date: string;
  /** Signed cents (income negative, Plaid convention). */
  amountCents: number;
}

export interface RunwayDay {
  date: string;
  items: RunwayDayItem[];
  netCents: number;
  balanceCents: number;
}

export interface RunwayResult {
  startingBalanceCents: number;
  days: RunwayDay[];
  minBalanceCents: number;
  minBalanceDate: string;
  negativeDates: string[];
}

/**
 * Build a day-by-day cashflow ledger. Starting balance is the sum of current
 * balances of active depository accounts. Each active recurring contributes
 * its projected occurrences as outflows (bills/subscriptions, positive cents)
 * or inflows (income, negative cents — Plaid sign flips the balance up).
 * An optional flat dailyVariableSpendCents is added as an extra daily outflow.
 * Optional one-off `projectedEntries` (projected-income ledger rows, e.g.
 * upcoming Recurly renewals) land on their expected bank date flagged
 * kind:'projected' — estimates with a confidence caveat, not promises.
 */
export function computeRunway(opts: {
  accounts: RunwayAccount[];
  recurrings: RecurringRow[];
  days: number;
  dailyVariableSpendCents?: number;
  fromDate?: string; // defaults to today (UTC)
  projectedEntries?: RunwayProjectedEntry[];
}): RunwayResult {
  const fromDate = opts.fromDate ?? new Date().toISOString().slice(0, 10);
  const toDate = addDays(fromDate, opts.days - 1);

  const startingBalanceCents = opts.accounts
    .filter((a) => a.isActive && (a.type === "depository" || a.type == null))
    .reduce((sum, a) => sum + (a.currentBalanceCents ?? 0), 0);

  // date -> items
  const byDate = new Map<string, RunwayDayItem[]>();
  for (const r of opts.recurrings) {
    const occurrences = projectOccurrences(r, fromDate, toDate);
    for (const occ of occurrences) {
      const list = byDate.get(occ.date) ?? [];
      list.push({ recurringId: r.id, name: r.name, kind: r.kind, amountCents: occ.amountCents });
      byDate.set(occ.date, list);
    }
  }

  // One-off projected-income entries land on their expected bank date.
  for (const p of opts.projectedEntries ?? []) {
    if (p.date < fromDate || p.date > toDate) continue;
    const list = byDate.get(p.date) ?? [];
    list.push({ recurringId: `projected:${p.id}`, name: p.name, kind: "projected", amountCents: p.amountCents });
    byDate.set(p.date, list);
  }

  const dailyVariable = opts.dailyVariableSpendCents ?? 0;

  const days: RunwayDay[] = [];
  let runningBalance = startingBalanceCents;
  let minBalanceCents = startingBalanceCents;
  let minBalanceDate = fromDate;
  const negativeDates: string[] = [];

  for (let i = 0; i < opts.days; i++) {
    const date = addDays(fromDate, i);
    const items = byDate.get(date) ?? [];
    // Recurring amountCents follow Plaid sign (positive = outflow); net effect on
    // balance is the negative of the sum of amountCents.
    const itemsNet = items.reduce((sum, item) => sum - item.amountCents, 0);
    const netCents = itemsNet - dailyVariable;
    runningBalance += netCents;

    days.push({ date, items, netCents, balanceCents: runningBalance });

    if (runningBalance < minBalanceCents) {
      minBalanceCents = runningBalance;
      minBalanceDate = date;
    }
    if (runningBalance < 0) negativeDates.push(date);
  }

  return { startingBalanceCents, days, minBalanceCents, minBalanceDate, negativeDates };
}
