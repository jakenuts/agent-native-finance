/**
 * /spending — the Spending analysis area (SpendingExplorer host).
 *
 * URL grammar (all state is addressable so the agent can `navigate` users
 * into any exact drill state):
 *   /spending                          overview: all expenses, last 12 MONTHLY buckets
 *   ?categoryId=<fp_categories.id>     category-scoped (merchant breakdown)
 *   ?merchant=<term>                   merchant-scoped (name-scope search)
 *   ?accountId=<fp_accounts.id>        optional account filter
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD     inclusive range
 *   ?granularity=day|week|month|quarter|year   BUCKET CADENCE — each bar is one
 *                                      bucket of this size (default month)
 *   ?bucket=<key>                      the selected bucket (highlighted; summary
 *                                      shows that bucket's total). Key format
 *                                      matches the cadence: day/week=YYYY-MM-DD,
 *                                      month=YYYY-MM, quarter=YYYY-Qn, year=YYYY.
 *   ?compare=1                         prior-period overlay on
 *   ?table=breakdown|transactions      table mode
 *
 * Period pills (Week/Month/Quarter/Year) set the BUCKET CADENCE: each bar is
 * one calendar week/month/quarter/year, N buckets going backward from now
 * (~12 weeks, ~12 months, ~8 quarters, ~5 years). Tapping a bar SELECTS it
 * (summary shows that bucket's total); the explicit "Break down" affordance
 * descends one granularity scoped to the selected bucket (month → weeks →
 * days); breakdown rows drill across into scoped views. Default cadence is
 * month.
 */
import { useActionQuery } from "@agent-native/core/client";
import { IconArrowLeft, IconExternalLink, IconPencil } from "@tabler/icons-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import { CategoryAvatar, MerchantAvatar } from "@/components/finance/MerchantAvatar";
import {
  SpendingExplorer,
  addDaysStr,
  isoWeekStartStr,
  quarterStartStr,
  todayStr,
  type CategoryInfo,
  type SpendingExplorerState,
  type SpendingGranularity,
  type SpendingTableMode,
} from "@/components/finance/SpendingExplorer";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Button } from "@/components/ui/button";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Spending - ${APP_TITLE}` }];
}

interface ListCategoriesResult {
  categories: CategoryInfo[];
}
interface BudgetHistoryResult {
  months: string[];
  categories: Array<{
    categoryId: string;
    series: Array<{ month: string; spentCents: number; targetCents: number | null }>;
  }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shiftMonthKey(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * Range+cadence for each period pill, relative to today. Each pill means "every
 * bar is one bucket of this size, N buckets going backward from now" — NOT a
 * lookback window shown at a finer granularity.
 */
function presetState(preset: SpendingCadence): {
  from: string;
  to: string;
  granularity: SpendingGranularity;
} {
  const today = todayStr();
  switch (preset) {
    case "week":
      // ~12 weekly bars ending this (Mon-anchored) week.
      return { from: addDaysStr(isoWeekStartStr(today), -7 * 11), to: today, granularity: "week" };
    case "month":
      // ~12 monthly bars ending this month. THE DEFAULT.
      return { from: `${shiftMonthKey(today.slice(0, 7), -11)}-01`, to: today, granularity: "month" };
    case "quarter":
      // ~8 quarterly bars ending this quarter (months aggregated → quarters).
      return { from: addQuarters(quarterStartStr(today), -7), to: today, granularity: "quarter" };
    case "year":
      // ~5 yearly bars ending this year (months aggregated → years).
      return { from: `${Number(today.slice(0, 4)) - 4}-01-01`, to: today, granularity: "year" };
  }
}

/** Shift a quarter-start (YYYY-MM-01) by `delta` quarters. */
function addQuarters(quarterStart: string, delta: number): string {
  return `${shiftMonthKey(quarterStart.slice(0, 7), delta * 3)}-01`;
}

type SpendingCadence = "week" | "month" | "quarter" | "year";

const PERIOD_PILLS = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
] as const;

export default function SpendingRoute() {
  useSetPageTitle("Spending");
  const [searchParams, setSearchParams] = useSearchParams();

  // ---- scope + state from URL (single source of truth) ----
  const categoryId = searchParams.get("categoryId");
  const merchant = searchParams.get("merchant");
  const accountId = searchParams.get("accountId");
  const defaults = presetState("month"); // month cadence is the default view
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const granParam = searchParams.get("granularity");
  const tableParam = searchParams.get("table");
  const bucketParam = searchParams.get("bucket");

  const granularity: SpendingGranularity =
    granParam === "day" ||
    granParam === "week" ||
    granParam === "month" ||
    granParam === "quarter" ||
    granParam === "year"
      ? granParam
      : defaults.granularity;

  const state: SpendingExplorerState = {
    from: fromParam && DATE_RE.test(fromParam) ? fromParam : defaults.from,
    to: toParam && DATE_RE.test(toParam) ? toParam : defaults.to,
    granularity,
    selectedBucket: bucketParam || null,
    compare: searchParams.get("compare") === "1",
    table:
      tableParam === "breakdown" || tableParam === "transactions"
        ? (tableParam as SpendingTableMode)
        : merchant
          ? "transactions" // a merchant's story is its transactions
          : "breakdown",
  };

  /** Write a state/scope patch into the URL (pushes history so Back un-drills). */
  function applyParams(patch: Record<string, string | null | undefined>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  }

  function onStateChange(patch: Partial<SpendingExplorerState>) {
    applyParams({
      ...(patch.from !== undefined ? { from: patch.from } : {}),
      ...(patch.to !== undefined ? { to: patch.to } : {}),
      ...(patch.granularity !== undefined ? { granularity: patch.granularity } : {}),
      ...(patch.selectedBucket !== undefined ? { bucket: patch.selectedBucket } : {}),
      ...(patch.compare !== undefined ? { compare: patch.compare ? "1" : null } : {}),
      ...(patch.table !== undefined ? { table: patch.table } : {}),
    });
  }

  function applyPreset(preset: SpendingCadence) {
    const p = presetState(preset);
    // Switching cadence resets the range and clears any selection/drill.
    applyParams({ from: p.from, to: p.to, granularity: p.granularity, bucket: null });
  }

  const activePreset = PERIOD_PILLS.find((p) => {
    const s = presetState(p.key);
    return s.from === state.from && s.to === state.to && s.granularity === state.granularity;
  })?.key;

  // ---- shared lookups ----
  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {});
  const catById = useMemo(() => {
    const map = new Map<string, CategoryInfo>();
    for (const c of categoriesQuery.data?.categories ?? []) map.set(c.id, c);
    return map;
  }, [categoriesQuery.data]);
  const category = categoryId ? catById.get(categoryId) : undefined;

  // Does the scoped category have any budget line? (drives the Edit budget link)
  const budgetQuery = useActionQuery<BudgetHistoryResult>(
    "budget-history",
    { months: 12, categoryIds: categoryId ? [categoryId] : [] },
    { enabled: Boolean(categoryId) },
  );
  const hasBudget = (budgetQuery.data?.categories?.[0]?.series ?? []).some(
    (s) => s.targetCents != null,
  );

  // ---- drill across ----
  // Preserve the currently-focused bucket + cadence when drilling into a
  // category/merchant — only the scope changes, not "when" the user was
  // looking at.
  function drillCategory(id: string) {
    applyParams({
      categoryId: id,
      merchant: null,
      table: null,
      bucket: state.selectedBucket,
      granularity: state.granularity,
    });
  }
  function drillMerchant(name: string) {
    applyParams({
      merchant: name,
      categoryId: null,
      table: null,
      bucket: state.selectedBucket,
      granularity: state.granularity,
    });
  }

  const scoped = Boolean(categoryId || merchant);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 lg:p-6">
      {/* ---- header (varies by scope) ---- */}
      <div className="space-y-1">
        {scoped ? (
          <button
            type="button"
            onClick={() => applyParams({ categoryId: null, merchant: null, table: null, bucket: null })}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconArrowLeft className="size-3.5" />
            All spending
          </button>
        ) : null}
        {categoryId ? (
          <div className="flex items-center gap-3">
            <CategoryAvatar
              categoryId={categoryId}
              icon={category?.icon}
              color={category?.color}
              fallbackName={category?.name ?? "Category"}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {category?.name ?? "Category"}
              </h1>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>Category spending</span>
                {hasBudget ? (
                  <Link
                    to="/budgets"
                    className="inline-flex items-center gap-1 text-xs underline decoration-dotted hover:text-foreground"
                  >
                    <IconPencil className="size-3" />
                    Edit budget
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        ) : merchant ? (
          <div className="flex items-center gap-3">
            <MerchantAvatar name={merchant} size="lg" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold tracking-tight">{merchant}</h1>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>Merchant spending</span>
                <Link
                  to={`/transactions?search=${encodeURIComponent(merchant)}&searchScope=name`}
                  className="inline-flex items-center gap-1 text-xs underline decoration-dotted hover:text-foreground"
                >
                  See transactions
                  <IconExternalLink className="size-3" />
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Spending</h1>
            <p className="text-sm text-muted-foreground">
              Where the money goes — tap a bar or row to drill in.
            </p>
          </div>
        )}
      </div>

      {/* ---- period pills ---- */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Period">
        {PERIOD_PILLS.map((pill) => (
          <Button
            key={pill.key}
            variant={activePreset === pill.key ? "secondary" : "outline"}
            size="sm"
            className={cn(
              "h-7 shrink-0 rounded-full px-3 text-xs",
              activePreset === pill.key && "font-semibold",
            )}
            aria-pressed={activePreset === pill.key}
            onClick={() => applyPreset(pill.key)}
          >
            {pill.label}
          </Button>
        ))}
      </div>

      <SpendingExplorer
        scope={{ categoryId, merchant, accountId }}
        state={state}
        onStateChange={onStateChange}
        onDrillCategory={drillCategory}
        onDrillMerchant={drillMerchant}
        categories={catById}
      />
    </div>
  );
}
