/**
 * SpendingExplorer — the core drill-anywhere spending analysis primitive.
 *
 * Given a transaction filter subset (category and/or merchant and/or account)
 * plus a time range and granularity, it renders:
 *   1. a time-series bar chart (bucketed spend in the subject's color, an
 *      optional prior-period dashed overlay aligned bucket-to-bucket, and a
 *      dotted budget-target line when a single budgeted category is in scope),
 *      where tapping a bucket drills DOWN in time (month → weeks → days),
 *   2. a summary strip (total / avg per bucket / delta vs the prior period),
 *   3. a toggleable table: BREAKDOWN group rows that drill ACROSS (categories
 *      when unscoped, merchants within a category) or the contributing
 *      TRANSACTIONS (date-grouped rows, tap → detail sheet).
 *
 * Fully controlled: all state lives in the parent (/spending reflects it into
 * URL search params) so every drill state is addressable — the agent can
 * `navigate` users into any exact view.
 */
import { useActionQuery } from "@agent-native/core/client";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconChevronRight,
  IconStack2,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CategoryAvatar, MerchantAvatar } from "@/components/finance/MerchantAvatar";
import { TransactionDetail } from "@/components/finance/TransactionDetail";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DEFAULT_CATEGORY_COLOR } from "@/lib/category-icons";
import {
  colorForName,
  formatDate,
  formatDateHeading,
  formatMoney,
  formatMoneyCompact,
  formatMonthLabel,
  formatSignedMoney,
} from "@/lib/finance-format";
import { cn } from "@/lib/utils";

/**
 * Bucket cadence: each chart bar represents ONE bucket of this size. `day`,
 * `week`, and `month` map directly to a `run-finance-query` groupBy; `quarter`
 * and `year` are aggregated in JS from month-grouped rows (the query engine
 * only groups by day/week/month).
 */
export type SpendingGranularity = "day" | "week" | "month" | "quarter" | "year";
export type SpendingTableMode = "breakdown" | "transactions";

/** The finest groupBy `run-finance-query` supports for a given cadence. */
function queryGranularity(g: SpendingGranularity): "day" | "week" | "month" {
  return g === "quarter" || g === "year" ? "month" : g;
}

export interface SpendingScope {
  /** Single category filter (fp_categories.id). */
  categoryId?: string | null;
  /** Merchant name-scope search term. */
  merchant?: string | null;
  /** Optional single account filter. */
  accountId?: string | null;
}

export interface SpendingExplorerState {
  /** Inclusive YYYY-MM-DD range. */
  from: string;
  to: string;
  granularity: SpendingGranularity;
  /** The currently-selected bucket key (highlighted; summary shows its total). */
  selectedBucket: string | null;
  /** Overlay the immediately-preceding same-length period on the chart. */
  compare: boolean;
  table: SpendingTableMode;
}

export interface CategoryInfo {
  id: string;
  name: string;
  group: string;
  icon: string | null;
  color: string | null;
}

interface GroupRow {
  key: string;
  label: string;
  valueCents: number;
  count: number;
}
interface GroupedResult {
  rows: GroupRow[];
  rowCount: number;
}
interface RawTxRow {
  id: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amountCents: number;
  pending: boolean;
  categoryId: string | null;
  category: string | null;
}
interface RawResult {
  rows: RawTxRow[];
  rowCount: number;
}
interface BudgetHistoryResult {
  months: string[];
  categories: Array<{
    categoryId: string;
    series: Array<{ month: string; spentCents: number; targetCents: number | null }>;
  }>;
}

// ---------------------------------------------------------------------------
// Date math (pure string/UTC — no local-timezone drift)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDaysStr(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** ISO week start (Monday) for a YYYY-MM-DD date — mirrors the server helper. */
export function isoWeekStartStr(date: string): string {
  const utc = toUtc(date);
  const dow = new Date(utc).getUTCDay(); // 0=Sun..6=Sat
  return fromUtc(utc - ((dow + 6) % 7) * DAY_MS);
}

export function monthStartStr(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function monthEndStr(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return fromUtc(Date.UTC(y, m, 0)); // day 0 of next month = last day of month
}

function shiftMonthKey(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

// ---- quarter / year keys (aggregated cadences) ----

/** Quarter start date (YYYY-MM-01) for a YYYY-MM-DD date. */
export function quarterStartStr(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qStartMonth).padStart(2, "0")}-01`;
}

/** Bucket key ("YYYY-Qn") for the quarter containing a YYYY-MM month key. */
function quarterKeyOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** First day of the quarter identified by a "YYYY-Qn" key. */
function quarterKeyStart(key: string): string {
  const [y, q] = key.split("-Q").map(Number);
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
}

/** Last day of the quarter identified by a "YYYY-Qn" key. */
function quarterKeyEnd(key: string): string {
  const [y, q] = key.split("-Q").map(Number);
  return monthEndStr(`${y}-${String(q * 3).padStart(2, "0")}`);
}

/** Complete, gap-free bucket key sequence covering [from, to]. */
function bucketKeys(from: string, to: string, granularity: SpendingGranularity): string[] {
  const keys: string[] = [];
  if (granularity === "year") {
    let y = Number(from.slice(0, 4));
    const end = Number(to.slice(0, 4));
    while (y <= end && keys.length < 400) keys.push(String(y++));
  } else if (granularity === "quarter") {
    let k = quarterKeyOfMonth(from.slice(0, 7));
    const end = quarterKeyOfMonth(to.slice(0, 7));
    while (k <= end && keys.length < 400) {
      keys.push(k);
      k = quarterKeyOfMonth(shiftMonthKey(quarterKeyStart(k).slice(0, 7), 3));
    }
  } else if (granularity === "month") {
    let k = from.slice(0, 7);
    const end = to.slice(0, 7);
    while (k <= end && keys.length < 400) {
      keys.push(k);
      k = shiftMonthKey(k, 1);
    }
  } else if (granularity === "week") {
    let k = isoWeekStartStr(from);
    const end = isoWeekStartStr(to);
    while (k <= end && keys.length < 400) {
      keys.push(k);
      k = addDaysStr(k, 7);
    }
  } else {
    let k = from;
    while (k <= to && keys.length < 400) {
      keys.push(k);
      k = addDaysStr(k, 1);
    }
  }
  return keys;
}

/** The bucket key a month row (YYYY-MM) rolls up into for the given cadence. */
function monthToBucketKey(month: string, granularity: SpendingGranularity): string {
  if (granularity === "year") return month.slice(0, 4);
  if (granularity === "quarter") return quarterKeyOfMonth(month);
  return month; // month cadence: identity
}

function bucketTickLabel(key: string, granularity: SpendingGranularity): string {
  if (granularity === "year") return key;
  if (granularity === "quarter") {
    const [y, q] = key.split("-Q");
    return `Q${q} '${y.slice(2)}`;
  }
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    const short = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
    return m === 1 ? `${short} ${String(y).slice(2)}` : short;
  }
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function bucketFullLabel(key: string, granularity: SpendingGranularity): string {
  if (granularity === "year") return key;
  if (granularity === "quarter") {
    const [y, q] = key.split("-Q");
    return `Q${q} ${y}`;
  }
  if (granularity === "month") return formatMonthLabel(key);
  if (granularity === "week") return `Week of ${formatDate(key)}`;
  return formatDate(key);
}

const GRANULARITY_NOUN: Record<SpendingGranularity, string> = {
  day: "day",
  week: "wk",
  month: "mo",
  quarter: "qtr",
  year: "yr",
};

/** The bucket key that contains `today` for the given cadence (the "current" bucket). */
function currentBucketKey(granularity: SpendingGranularity, today: string): string {
  if (granularity === "year") return today.slice(0, 4);
  if (granularity === "quarter") return quarterKeyOfMonth(today.slice(0, 7));
  if (granularity === "month") return today.slice(0, 7);
  if (granularity === "week") return isoWeekStartStr(today);
  return today;
}

/** Inclusive [from, to] calendar date range a single bucket key spans. */
function bucketDateRange(
  key: string,
  granularity: SpendingGranularity,
): { from: string; to: string } {
  switch (granularity) {
    case "year":
      return { from: `${key}-01-01`, to: monthEndStr(`${key}-12`) };
    case "quarter":
      return { from: quarterKeyStart(key), to: quarterKeyEnd(key) };
    case "month":
      return { from: `${key}-01`, to: monthEndStr(key) };
    case "week":
      return { from: key, to: addDaysStr(key, 6) };
    default:
      return { from: key, to: key };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SpendingExplorer({
  scope,
  state,
  onStateChange,
  onDrillCategory,
  onDrillMerchant,
  categories,
}: {
  scope: SpendingScope;
  state: SpendingExplorerState;
  onStateChange: (patch: Partial<SpendingExplorerState>) => void;
  /** Drill across into a category-scoped view. */
  onDrillCategory: (categoryId: string) => void;
  /** Drill across into a merchant-scoped view. */
  onDrillMerchant: (merchant: string) => void;
  /** Category lookup (id → info) shared from the page. */
  categories: Map<string, CategoryInfo>;
}) {
  const { from, to, granularity, selectedBucket, compare, table } = state;
  const [detailId, setDetailId] = useState<string | null>(null);
  const qGran = queryGranularity(granularity);

  const category = scope.categoryId ? categories.get(scope.categoryId) : undefined;
  const subjectColor = scope.categoryId
    ? (category?.color ?? DEFAULT_CATEGORY_COLOR)
    : scope.merchant
      ? colorForName(scope.merchant)
      : "hsl(var(--primary))";

  const baseFilters = useMemo(() => {
    const f: Record<string, unknown> = { minCents: 1 };
    if (scope.categoryId) f.categoryIds = [scope.categoryId];
    if (scope.merchant) {
      f.search = scope.merchant;
      f.searchScope = "name";
    }
    if (scope.accountId) f.accountIds = [scope.accountId];
    return f;
  }, [scope.categoryId, scope.merchant, scope.accountId]);

  const today = todayStr();
  const hasExplicitSelection = state.selectedBucket != null;

  // Prior window: same length, immediately before, aligned bucket-to-bucket.
  const priorTo = addDaysStr(from, -1);
  const priorFrom = addDaysStr(priorTo, -daysBetween(from, to));

  const seriesQuery = useActionQuery<GroupedResult>("run-finance-query", {
    query: JSON.stringify({
      from: "transactions",
      filters: { ...baseFilters, dateFrom: from, dateTo: to },
      groupBy: qGran,
      metric: "sum",
      sort: "asc",
      limit: 400,
    }),
  });
  const priorQuery = useActionQuery<GroupedResult>("run-finance-query", {
    query: JSON.stringify({
      from: "transactions",
      filters: { ...baseFilters, dateFrom: priorFrom, dateTo: priorTo },
      groupBy: qGran,
      metric: "sum",
      sort: "asc",
      limit: 400,
    }),
  });

  // For quarter/year cadences the query grouped by MONTH, so roll month rows
  // up into the cadence's bucket keys here (cents-exact — no rounding until /100).
  const currentByBucket = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of seriesQuery.data?.rows ?? []) {
      const bucket = monthToBucketKey(r.key, granularity);
      map.set(bucket, (map.get(bucket) ?? 0) + r.valueCents);
    }
    return map;
  }, [seriesQuery.data, granularity]);

  // The bucket the summary and the breakdown/transactions tables focus on: an
  // explicit selection if the user tapped a bar; otherwise the CURRENT
  // (most-recent) bucket — UNLESS that bucket has no spend at all, in which
  // case fall back to the most recent bucket (still <= today) that DOES have
  // spend, so a category/merchant with nothing this month doesn't default to
  // a useless "$0.00 · no spending" headline when earlier bars have data. The
  // chart always spans the full range for context.
  const currentKey = currentBucketKey(granularity, today);
  const effectiveBucket = useMemo(() => {
    if (hasExplicitSelection) return state.selectedBucket as string;
    if ((currentByBucket.get(currentKey) ?? 0) > 0) return currentKey;
    const keys = bucketKeys(from, to, granularity);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      if (key <= today && (currentByBucket.get(key) ?? 0) > 0) return key;
    }
    return currentKey;
  }, [hasExplicitSelection, state.selectedBucket, currentByBucket, currentKey, from, to, granularity, today]);
  const scopedRange = bucketDateRange(effectiveBucket, granularity);

  // Breakdown dimension: categories when unscoped, merchants inside a
  // category, categories for a merchant subset (shows how it's categorized).
  const breakdownBy: "category" | "merchant" = scope.categoryId ? "merchant" : "category";
  const breakdownQuery = useActionQuery<GroupedResult>(
    "run-finance-query",
    {
      query: JSON.stringify({
        from: "transactions",
        filters: { ...baseFilters, dateFrom: scopedRange.from, dateTo: scopedRange.to },
        groupBy: breakdownBy,
        metric: "sum",
        sort: "desc",
        limit: 100,
      }),
    },
    { enabled: table === "breakdown" },
  );

  const txQuery = useActionQuery<RawResult>(
    "run-finance-query",
    {
      query: JSON.stringify({
        from: "transactions",
        filters: { ...baseFilters, dateFrom: scopedRange.from, dateTo: scopedRange.to },
        sort: "desc",
        limit: 500,
      }),
    },
    { enabled: table === "transactions" },
  );

  // Budget target line: only for a single category at month granularity —
  // targets are monthly numbers, so drawing them over weeks/days would lie.
  const budgetQuery = useActionQuery<BudgetHistoryResult>(
    "budget-history",
    { months: 12, categoryIds: scope.categoryId ? [scope.categoryId] : [] },
    { enabled: Boolean(scope.categoryId) && granularity === "month" },
  );
  const budgetTargetCents = useMemo(() => {
    const series = budgetQuery.data?.categories?.[0]?.series ?? [];
    const inRange = series.filter(
      (s) => s.targetCents != null && s.month >= from.slice(0, 7) && s.month <= to.slice(0, 7),
    );
    return inRange.length > 0 ? inRange[inRange.length - 1].targetCents : null;
  }, [budgetQuery.data, from, to]);

  // ---- chart data: complete bucket sequence, zero-filled, prior aligned ----
  const priorByBucket = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of priorQuery.data?.rows ?? []) {
      const bucket = monthToBucketKey(r.key, granularity);
      map.set(bucket, (map.get(bucket) ?? 0) + r.valueCents);
    }
    return map;
  }, [priorQuery.data, granularity]);

  const chartData = useMemo(() => {
    const keys = bucketKeys(from, to, granularity);
    const priorKeys = bucketKeys(priorFrom, priorTo, granularity);
    return keys.map((key, i) => ({
      key,
      tick: bucketTickLabel(key, granularity),
      current: (currentByBucket.get(key) ?? 0) / 100,
      prior:
        priorKeys[i] != null && priorByBucket.has(priorKeys[i])
          ? (priorByBucket.get(priorKeys[i]) ?? 0) / 100
          : priorKeys[i] != null
            ? 0
            : null,
      priorKey: priorKeys[i] ?? null,
    }));
  }, [currentByBucket, priorByBucket, from, to, priorFrom, priorTo, granularity]);

  const totalCents = (seriesQuery.data?.rows ?? []).reduce((s, r) => s + r.valueCents, 0);
  const priorTotalCents = (priorQuery.data?.rows ?? []).reduce((s, r) => s + r.valueCents, 0);
  const elapsedBuckets = chartData.filter((b) => b.key <= today).length || 1;
  const avgCents = totalCents / elapsedBuckets;
  const deltaCents = totalCents - priorTotalCents;
  const deltaPct = priorTotalCents > 0 ? (deltaCents / priorTotalCents) * 100 : null;

  // ---- selection (tap a bar) ----
  // `effectiveBucket` is the focused bucket (explicit selection, else current).
  // The summary + tables key off its total; the chart highlights it.
  const effectiveBucketCents = currentByBucket.get(effectiveBucket) ?? 0;
  function toggleSelect(key: string) {
    onStateChange({ selectedBucket: selectedBucket === key ? null : key });
  }

  // ---- break down: descend one granularity, scoped to the focused bucket ----
  const breakDown = useMemo(() => {
    const key = effectiveBucket;
    switch (granularity) {
      case "year":
        return {
          apply: () =>
            onStateChange({
              from: `${key}-01-01`,
              to: monthEndStr(`${key}-12`),
              granularity: "month",
              selectedBucket: null,
            }),
          noun: "months",
        };
      case "quarter":
        return {
          apply: () =>
            onStateChange({
              from: quarterKeyStart(key),
              to: quarterKeyEnd(key),
              granularity: "month",
              selectedBucket: null,
            }),
          noun: "months",
        };
      case "month":
        return {
          apply: () =>
            onStateChange({
              from: `${key}-01`,
              to: monthEndStr(key),
              granularity: "week",
              selectedBucket: null,
            }),
          noun: "weeks",
        };
      case "week":
        return {
          apply: () =>
            onStateChange({
              from: key,
              to: addDaysStr(key, 6),
              granularity: "day",
              selectedBucket: null,
            }),
          noun: "days",
        };
      default:
        // day → the day's transactions
        return {
          apply: () =>
            onStateChange({ from: key, to: key, table: "transactions", selectedBucket: null }),
          noun: "transactions",
        };
    }
  }, [effectiveBucket, granularity, onStateChange]);

  // ---- zoom out (breadcrumb/back affordance) ----
  const zoomOut = useMemo(() => {
    const singleDay = from === to;
    const singleWeek =
      !singleDay && from === isoWeekStartStr(from) && daysBetween(from, to) <= 6;
    const singleMonth =
      !singleDay &&
      !singleWeek &&
      from === monthStartStr(from) &&
      to.slice(0, 7) === from.slice(0, 7);
    if (singleDay) {
      const wk = isoWeekStartStr(from);
      return {
        label: formatDate(from),
        apply: () =>
          onStateChange({ from: wk, to: addDaysStr(wk, 6), granularity: "day", table: "breakdown" }),
      };
    }
    if (singleWeek) {
      const month = from.slice(0, 7);
      return {
        label: `Week of ${formatDate(from)}`,
        apply: () =>
          onStateChange({ from: `${month}-01`, to: monthEndStr(month), granularity: "week" }),
      };
    }
    if (singleMonth && granularity !== "month") {
      const start = `${shiftMonthKey(today.slice(0, 7), -11)}-01`;
      return {
        label: formatMonthLabel(from.slice(0, 7)),
        apply: () => onStateChange({ from: start, to: today, granularity: "month" }),
      };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, granularity]);

  const isLoading = seriesQuery.isLoading || priorQuery.isLoading;

  // Bar-top value label (compact bucket total). Typed loosely because recharts'
  // LabelList content payload isn't cleanly exported.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function renderBarTotal(props: any) {
    const { x, y, width, value, index } = props ?? {};
    if (value == null || Number(value) <= 0) return null;
    const key = chartData[index ?? -1]?.key;
    // Dense chart (>8 bars): only label the focused bucket. Sparse: label all.
    if (chartData.length > 8 && key !== effectiveBucket) return null;
    const cx = Number(x) + Number(width) / 2;
    return (
      <text
        x={cx}
        y={Number(y) - 4}
        textAnchor="middle"
        fontSize={10}
        className="fill-foreground tabular-nums"
        fontWeight={key === effectiveBucket ? 600 : 400}
      >
        {formatMoneyCompact(Number(value))}
      </text>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---- chart card: summary strip + time series ---- */}
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              {/* Header line = the focused period label (breadcrumb when
                  drilled; the current/selected bucket otherwise). The headline
                  number is that focused bucket's total — NOT the range total. */}
              {zoomOut ? (
                <button
                  type="button"
                  onClick={zoomOut.apply}
                  className="mb-0.5 flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <IconArrowLeft className="size-3.5" />
                  {zoomOut.label}
                </button>
              ) : hasExplicitSelection ? (
                <button
                  type="button"
                  onClick={() => onStateChange({ selectedBucket: null })}
                  className="mb-0.5 flex items-center gap-1 text-xs font-medium text-foreground transition-colors hover:text-muted-foreground"
                >
                  {bucketFullLabel(effectiveBucket, granularity)}
                  <IconX className="size-3" />
                </button>
              ) : (
                <p className="mb-0.5 text-xs font-medium text-foreground">
                  {bucketFullLabel(effectiveBucket, granularity)}
                </p>
              )}
              {isLoading ? (
                <Skeleton className="h-8 w-32" />
              ) : (
                <p className="text-2xl font-semibold tabular-nums sm:text-3xl">
                  {formatMoney(effectiveBucketCents / 100)}
                </p>
              )}
              {/* Context: average per bucket + total across the whole range. */}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {formatMoney(avgCents / 100)}/{GRANULARITY_NOUN[granularity]} avg ·{" "}
                  {formatMoney(totalCents / 100)} total
                </span>
                {!isLoading && deltaPct != null ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 font-medium tabular-nums",
                      deltaCents >= 0 ? "text-fin-warning" : "text-fin-positive",
                    )}
                  >
                    {deltaCents >= 0 ? (
                      <IconArrowUp className="size-3" />
                    ) : (
                      <IconArrowDown className="size-3" />
                    )}
                    {Math.abs(deltaPct).toFixed(0)}% vs prior
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {breakDown ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={breakDown.apply}
                >
                  <IconStack2 className="size-3.5" />
                  Break down
                </Button>
              ) : null}
              <Button
                variant={compare ? "secondary" : "outline"}
                size="sm"
                className="h-7 text-xs"
                aria-pressed={compare}
                onClick={() => onStateChange({ compare: !compare })}
              >
                Compare
              </Button>
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="mt-4 h-52 w-full" />
          ) : (
            <div className="mt-4 h-52 w-full sm:h-60">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="tick"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={20}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(v) => formatMoneyCompact(Number(v))}
                    fontSize={11}
                    width={42}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--accent))", opacity: 0.4 }}
                    formatter={(v: unknown, name: unknown) => [
                      formatMoney(Number(v ?? 0)),
                      name === "prior" ? "Prior period" : "Spend",
                    ]}
                    labelFormatter={(_l, payload) => {
                      const p = payload?.[0]?.payload;
                      if (!p) return "";
                      const label = bucketFullLabel(p.key, granularity);
                      return compare && p.priorKey
                        ? `${label} · prior: ${bucketFullLabel(p.priorKey, granularity)}`
                        : label;
                    }}
                  />
                  {budgetTargetCents != null ? (
                    <ReferenceLine
                      y={budgetTargetCents / 100}
                      stroke="hsl(var(--foreground))"
                      strokeDasharray="2 4"
                      strokeWidth={1.5}
                      label={{
                        value: `Budget ${formatMoneyCompact(budgetTargetCents / 100)}`,
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                    />
                  ) : null}
                  <Bar
                    dataKey="current"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={40}
                    cursor="pointer"
                    isAnimationActive={false}
                    onClick={(data) => {
                      const key = (data as { payload?: { key?: string } } | undefined)
                        ?.payload?.key;
                      if (key) toggleSelect(key);
                    }}
                  >
                    {chartData.map((d) => {
                      // Outline the focused bucket (current by default). When the
                      // user has EXPLICITLY selected one, dim the rest to isolate
                      // it; with no explicit selection, keep every bar full-color
                      // so the trend still reads and just outline the current one.
                      const isFocus = d.key === effectiveBucket;
                      return (
                        <Cell
                          key={d.key}
                          fill={subjectColor}
                          fillOpacity={!hasExplicitSelection || isFocus ? 1 : 0.35}
                          stroke={isFocus ? "hsl(var(--foreground))" : undefined}
                          strokeWidth={isFocus ? 1.5 : 0}
                        />
                      );
                    })}
                    {/* Bar-top totals: label all when sparse (<= 8 bars); on a
                        dense chart label only the focused bucket. */}
                    <LabelList dataKey="current" position="top" content={renderBarTotal} />
                  </Bar>
                  {compare ? (
                    <Line
                      type="monotone"
                      dataKey="prior"
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                      dot={false}
                      isAnimationActive={false}
                    />
                  ) : null}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          {!isLoading && totalCents === 0 ? (
            <p className="pt-2 text-center text-xs text-muted-foreground">
              No spending in this period.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---- table card: breakdown / transactions ---- */}
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
            <h2 className="min-w-0 truncate text-sm font-semibold">
              {table === "transactions"
                ? "Transactions"
                : breakdownBy === "merchant"
                  ? "Merchants"
                  : "Categories"}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {bucketFullLabel(effectiveBucket, granularity)}
              </span>
            </h2>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={table}
              onValueChange={(v) => {
                if (v === "breakdown" || v === "transactions") onStateChange({ table: v });
              }}
              aria-label="Table mode"
            >
              <ToggleGroupItem value="breakdown" className="h-7 px-2.5 text-xs">
                Breakdown
              </ToggleGroupItem>
              <ToggleGroupItem value="transactions" className="h-7 px-2.5 text-xs">
                Transactions
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {table === "breakdown" ? (
            <BreakdownTable
              query={breakdownQuery}
              by={breakdownBy}
              totalCents={totalCents}
              categories={categories}
              subjectColor={subjectColor}
              onDrillCategory={onDrillCategory}
              onDrillMerchant={onDrillMerchant}
            />
          ) : (
            <TransactionsTable
              query={txQuery}
              categories={categories}
              onOpen={(id) => setDetailId(id)}
            />
          )}
        </CardContent>
      </Card>

      <TransactionDetail
        transactionId={detailId}
        open={detailId !== null}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown table (group rows with % bars, drill across)
// ---------------------------------------------------------------------------

function BreakdownTable({
  query,
  by,
  totalCents,
  categories,
  subjectColor,
  onDrillCategory,
  onDrillMerchant,
}: {
  query: { data?: GroupedResult; isLoading: boolean };
  by: "category" | "merchant";
  totalCents: number;
  categories: Map<string, CategoryInfo>;
  subjectColor: string;
  onDrillCategory: (categoryId: string) => void;
  onDrillMerchant: (merchant: string) => void;
}) {
  if (query.isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  const rows = (query.data?.rows ?? []).filter((r) => r.valueCents > 0);
  if (rows.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-sm text-muted-foreground">
        Nothing to break down for this period.
      </p>
    );
  }
  // % is relative to what's shown (the scoped bucket's total), not the range.
  const denom = rows.reduce((s, r) => s + Math.max(0, r.valueCents), 0);

  return (
    <div className="divide-y divide-border/60 pb-1">
      {rows.map((row) => {
        const cat = by === "category" ? categories.get(row.key) : undefined;
        const rowColor =
          by === "category"
            ? row.key === "uncategorized"
              ? DEFAULT_CATEGORY_COLOR
              : (cat?.color ?? DEFAULT_CATEGORY_COLOR)
            : subjectColor;
        const pct = denom > 0 ? (row.valueCents / denom) * 100 : 0;
        const drillable = by === "merchant" || row.key !== "uncategorized";
        const drill = () => {
          if (!drillable) return;
          if (by === "category") onDrillCategory(row.key);
          else onDrillMerchant(row.label);
        };
        return (
          <button
            key={row.key}
            type="button"
            onClick={drill}
            disabled={!drillable}
            className={cn(
              "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
              drillable ? "cursor-pointer hover:bg-accent/40" : "cursor-default",
            )}
          >
            {by === "category" ? (
              <CategoryAvatar
                categoryId={row.key === "uncategorized" ? null : row.key}
                icon={cat?.icon}
                color={cat?.color}
                fallbackName={row.label}
                size="md"
              />
            ) : (
              <MerchantAvatar name={row.label} size="md" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{row.label}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatMoney(row.valueCents / 100)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(1.5, pct)}%`, backgroundColor: rowColor }}
                  />
                </div>
                <span className="shrink-0 whitespace-nowrap text-end text-[11px] tabular-nums text-muted-foreground">
                  {pct.toFixed(0)}% · {row.count} txn{row.count === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            {drillable ? (
              <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contributing transactions (date-grouped rows, tap → detail sheet)
// ---------------------------------------------------------------------------

function TransactionsTable({
  query,
  categories,
  onOpen,
}: {
  query: { data?: RawResult; isLoading: boolean };
  categories: Map<string, CategoryInfo>;
  onOpen: (id: string) => void;
}) {
  const rows = query.data?.rows ?? [];
  const grouped = useMemo(() => {
    const groups: Array<{ date: string; rows: RawTxRow[] }> = [];
    for (const row of rows) {
      const date = row.date ?? "";
      const last = groups[groups.length - 1];
      if (last && last.date === date) last.rows.push(row);
      else groups.push({ date, rows: [row] });
    }
    return groups;
  }, [rows]);

  if (query.isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-sm text-muted-foreground">
        No transactions in this period.
      </p>
    );
  }

  return (
    <div className="divide-y divide-border pb-1">
      {grouped.map((group) => (
        <div key={group.date}>
          <div className="flex items-center justify-between bg-muted/40 px-4 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {formatDateHeading(group.date)}
            </span>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {formatSignedMoney(group.rows.reduce((s, r) => s + r.amountCents, 0) / 100)}
            </span>
          </div>
          {group.rows.map((tx) => {
            const cat = tx.categoryId ? categories.get(tx.categoryId) : undefined;
            return (
              <button
                key={tx.id}
                type="button"
                onClick={() => onOpen(tx.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40"
              >
                <CategoryAvatar
                  categoryId={tx.categoryId}
                  icon={cat?.icon}
                  color={cat?.color}
                  fallbackName={tx.merchantName || tx.name}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {tx.merchantName || tx.name || "Unknown"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {tx.category ?? "Uncategorized"}
                    {tx.pending ? " · Pending" : ""}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-sm font-semibold tabular-nums",
                    tx.amountCents < 0 && "text-fin-positive",
                  )}
                >
                  {formatSignedMoney(tx.amountCents / 100)}
                </span>
                <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      ))}
      {query.data && query.data.rowCount >= 500 ? (
        <p className="px-4 py-2 text-center text-xs text-muted-foreground">
          Showing the 500 most recent transactions in range.
        </p>
      ) : null}
    </div>
  );
}
