/**
 * /budgets — monthly category budgets: month navigator, summary rollup,
 * inline-editable per-category targets vs. spend, unbudgeted spend
 * ("add target" shortcuts), auto-fill from history (suggest-budget), copy
 * last month forward, and a collapsible 12-month spend-vs-target history
 * report (recharts ComposedChart: spend bars + target line).
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { iconForCategory, DEFAULT_CATEGORY_COLOR } from "@/lib/category-icons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { APP_TITLE } from "@/lib/app-config";
import {
  currentMonth,
  formatMonthLabel,
  formatMoney,
  formatMoneyCompact,
  shiftMonth,
} from "@/lib/finance-format";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Budgets - ${APP_TITLE}` }];
}

interface BudgetedRow {
  categoryId: string;
  name: string;
  icon: string | null;
  color: string | null;
  targetCents: number;
  spentCents: number;
  remainingCents: number;
  pctUsed: number;
}
interface UnbudgetedRow {
  categoryId: string;
  name: string;
  icon: string | null;
  color: string | null;
  spentCents: number;
}
interface GetBudgetResult {
  month: string;
  profile: string;
  budgeted: BudgetedRow[];
  unbudgeted: UnbudgetedRow[];
  rollup: { totalTargetCents: number; totalSpentCents: number; remainingCents: number };
  daysLeft: number;
  daysInMonth: number;
}
interface CategoryOption {
  id: string;
  name: string;
  group: string;
  icon: string | null;
  color: string | null;
}
interface ListCategoriesResult {
  categories: CategoryOption[];
}
interface SuggestBudgetRow {
  categoryId: string;
  name: string;
  icon: string | null;
  color: string | null;
  avgMonthlySpendCents: number;
  medianMonthlySpendCents: number;
  suggestedTargetCents: number;
  monthsWithData: number;
}
interface SuggestBudgetResult {
  suggestions: SuggestBudgetRow[];
  lookbackMonths: number;
}
interface BudgetHistoryCategory {
  categoryId: string;
  name: string;
  icon: string | null;
  color: string | null;
  series: Array<{ month: string; spentCents: number; targetCents: number | null }>;
}
interface BudgetHistoryResult {
  months: string[];
  categories: BudgetHistoryCategory[];
}

function progressColor(pct: number, over = false): string {
  // `over` (remainingCents < 0) forces red even when pctUsed caps at 100 —
  // e.g. a $0 "spend nothing" target that has any spend.
  if (over || pct > 100) return "bg-destructive [&>div]:bg-destructive";
  if (pct >= 80) return "[&>div]:bg-fin-warning";
  return "[&>div]:bg-fin-positive";
}

function CategoryIcon({ slug, color }: { slug: string | null; color: string | null }) {
  const Icon = iconForCategory(slug);
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: `${color ?? DEFAULT_CATEGORY_COLOR}22` }}
    >
      <Icon className="size-4" style={{ color: color ?? DEFAULT_CATEGORY_COLOR }} />
    </span>
  );
}

/** Inline currency input that saves on blur (or Enter). */
function InlineTargetInput({
  initialCents,
  onSave,
}: {
  initialCents: number;
  onSave: (cents: number) => void;
}) {
  const [draft, setDraft] = useState(() => (initialCents / 100).toFixed(2));

  function commit() {
    const cents = Math.round(Number(draft || "0") * 100);
    if (cents !== initialCents) onSave(cents);
  }

  return (
    <div className="flex items-center gap-1">
      <span className="text-sm text-muted-foreground">$</span>
      <Input
        type="number"
        min="0"
        step="1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="h-8 w-24 text-right tabular-nums"
      />
    </div>
  );
}

export default function BudgetsRoute() {
  useSetPageTitle("Budgets");
  const [month, setMonth] = useState(() => currentMonth());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addCategoryId, setAddCategoryId] = useState<string>("");
  const [addTargetDraft, setAddTargetDraft] = useState<string>("");

  const budgetQuery = useActionQuery<GetBudgetResult>("get-budget", { month });
  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {});
  const suggestQuery = useActionQuery<SuggestBudgetResult>("suggest-budget", { month, lookbackMonths: 3 });
  const historyQuery = useActionQuery<BudgetHistoryResult>(
    "budget-history",
    { months: 12 },
    { enabled: historyOpen },
  );

  const setLineMutation = useActionMutation("set-budget-line");
  const copyForwardMutation = useActionMutation("copy-budget-forward");

  const data = budgetQuery.data;
  const suggestByCategory = useMemo(() => {
    const map = new Map<string, SuggestBudgetRow>();
    for (const s of suggestQuery.data?.suggestions ?? []) map.set(s.categoryId, s);
    return map;
  }, [suggestQuery.data]);

  const budgetedCategoryIds = useMemo(
    () => new Set((data?.budgeted ?? []).map((b) => b.categoryId)),
    [data],
  );
  const expenseCategories = (categoriesQuery.data?.categories ?? []).filter(
    (c) => c.group === "expenses" && !budgetedCategoryIds.has(c.id),
  );

  function saveTarget(categoryId: string, targetCents: number) {
    setLineMutation.mutate(
      { month, categoryId, targetCents },
      {
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save budget"),
      },
    );
  }

  function removeLine(categoryId: string) {
    setLineMutation.mutate(
      { month, categoryId, remove: true },
      {
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove budget"),
      },
    );
  }

  function handleAddCategory() {
    const cents = Math.round(Number(addTargetDraft || "0") * 100);
    if (!addCategoryId) {
      toast.error("Pick a category.");
      return;
    }
    if (cents < 0) {
      toast.error("Target can't be negative.");
      return;
    }
    setLineMutation.mutate(
      { month, categoryId: addCategoryId, targetCents: cents },
      {
        onSuccess: () => {
          toast.success("Budget added");
          setAddCategoryId("");
          setAddTargetDraft("");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add budget"),
      },
    );
  }

  function handleCopyLastMonth() {
    copyForwardMutation.mutate(
      { toMonth: month },
      {
        onSuccess: (result: { copied: number; skipped: number }) => {
          toast.success(`Copied ${result.copied} budget line${result.copied === 1 ? "" : "s"}${result.skipped ? ` (${result.skipped} already set)` : ""}`);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Copy failed"),
      },
    );
  }

  function handleAutoFill() {
    const suggestions = suggestQuery.data?.suggestions ?? [];
    const toApply = suggestions.filter((s) => !budgetedCategoryIds.has(s.categoryId));
    if (toApply.length === 0) {
      toast.info("No new suggestions to apply — every spending category already has a target.");
      return;
    }
    let remaining = toApply.length;
    for (const s of toApply) {
      setLineMutation.mutate(
        { month, categoryId: s.categoryId, targetCents: s.suggestedTargetCents },
        {
          onSettled: () => {
            remaining--;
            if (remaining === 0) toast.success(`Auto-filled ${toApply.length} categories from your history`);
          },
        },
      );
    }
  }

  function handleAddTargetFor(categoryId: string) {
    const suggestion = suggestByCategory.get(categoryId);
    const cents = suggestion?.suggestedTargetCents ?? 0;
    if (cents <= 0) {
      setAddCategoryId(categoryId);
      return;
    }
    saveTarget(categoryId, cents);
  }

  const rollup = data?.rollup;
  const rollupPct = rollup && rollup.totalTargetCents > 0
    ? Math.min(100, Math.round((rollup.totalSpentCents / rollup.totalTargetCents) * 100))
    : 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Budgets</h1>
          <p className="text-sm text-muted-foreground">
            Set monthly spending targets per category and track progress.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Previous month"
          >
            <IconChevronLeft className="size-4" />
          </Button>
          <span className="min-w-32 px-1 text-center text-sm font-medium tabular-nums">
            {formatMonthLabel(month)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            aria-label="Next month"
          >
            <IconChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* Summary header */}
      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-2">
          <CardDescription>
            {data ? `${data.daysLeft} of ${data.daysInMonth} days left` : "Loading..."}
          </CardDescription>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            {budgetQuery.isLoading ? (
              <Skeleton className="h-9 w-64" />
            ) : (
              <>
                <div>
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatMoney((rollup?.totalSpentCents ?? 0) / 100)}
                  </span>
                  <span className="text-sm text-muted-foreground"> spent of {formatMoney((rollup?.totalTargetCents ?? 0) / 100)}</span>
                </div>
                <div
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    (rollup?.remainingCents ?? 0) < 0 ? "text-destructive" : "text-fin-positive",
                  )}
                >
                  {(rollup?.remainingCents ?? 0) < 0 ? "Over by " : "Remaining "}
                  {formatMoney(Math.abs((rollup?.remainingCents ?? 0)) / 100)}
                </div>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Progress value={rollupPct} className={progressColor(rollupPct, (rollup?.remainingCents ?? 0) < 0)} />
        </CardContent>
      </Card>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={handleCopyLastMonth} disabled={copyForwardMutation.isPending}>
          <IconCopy className="size-4" />
          Copy last month
        </Button>
        <Button variant="outline" size="sm" onClick={handleAutoFill} disabled={setLineMutation.isPending || suggestQuery.isLoading}>
          <IconSparkles className="size-4" />
          Auto-fill from history
        </Button>
      </div>

      {/* Budgeted categories */}
      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Category budgets</CardTitle>
          <CardDescription>Inline-editable targets; saves automatically on blur.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {budgetQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : (data?.budgeted.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No budgets set for {formatMonthLabel(month)} yet. Add a category below, copy last month, or auto-fill from history.
            </p>
          ) : (
            data?.budgeted.map((row) => {
              const pct = Math.min(150, row.pctUsed);
              return (
                <div
                  key={row.categoryId}
                  className="flex flex-col gap-2 rounded-lg px-0 py-2.5 transition-colors hover:bg-accent/40 sm:flex-row sm:items-center sm:px-2"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <CategoryIcon slug={row.icon} color={row.color} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-medium">{row.name}</p>
                        {/* Mobile: spent lives up here so the numbers row below fits. */}
                        <p className="shrink-0 text-xs tabular-nums text-muted-foreground sm:hidden">
                          {formatMoney(row.spentCents / 100)} spent
                        </p>
                      </div>
                      <Progress value={Math.min(100, pct)} className={cn("mt-1 h-1.5", progressColor(row.pctUsed, row.remainingCents < 0))} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-2 ps-9 sm:justify-normal sm:gap-4 sm:ps-0">
                    <div className="text-sm tabular-nums sm:w-24 sm:text-end">
                      <span
                        className={cn(
                          row.remainingCents < 0 ? "font-semibold text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {row.remainingCents < 0 ? "-" : ""}
                        {formatMoney(Math.abs(row.remainingCents) / 100)}
                        <span className="sm:hidden"> left</span>
                      </span>
                    </div>
                    <div className="hidden w-20 shrink-0 text-end text-sm tabular-nums text-muted-foreground sm:block">
                      {formatMoney(row.spentCents / 100)}
                    </div>
                    <div className="flex items-center gap-1">
                      <InlineTargetInput
                        key={`${row.categoryId}-${row.targetCents}`}
                        initialCents={row.targetCents}
                        onSave={(cents) => saveTarget(row.categoryId, cents)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${row.name} budget`}
                        onClick={() => removeLine(row.categoryId)}
                      >
                        <IconTrash className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Add category budget */}
      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Add category budget</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={addCategoryId} onValueChange={setAddCategoryId}>
              <SelectTrigger className="h-9 w-56">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {expenseCategories.map((c) => {
                  const suggestion = suggestByCategory.get(c.id);
                  return (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {suggestion && suggestion.suggestedTargetCents > 0
                        ? ` (~${formatMoney(suggestion.suggestedTargetCents / 100)}/mo)`
                        : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="Target"
                value={addTargetDraft}
                onChange={(e) => setAddTargetDraft(e.target.value)}
                className="h-9 w-28"
              />
            </div>
            <Button size="sm" onClick={handleAddCategory} disabled={setLineMutation.isPending}>
              <IconPlus className="size-4" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Unbudgeted spending */}
      {(data?.unbudgeted.length ?? 0) > 0 ? (
        <Card className="rounded-2xl shadow-sm border-fin-warning/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconAlertTriangle className="size-4 text-fin-warning" />
              Unbudgeted spending
            </CardTitle>
            <CardDescription>Categories with spend this month but no target set.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {data?.unbudgeted.map((row) => (
              <div
                key={row.categoryId}
                className="flex items-center gap-2.5 rounded-lg px-0 py-2 transition-colors hover:bg-accent/40 sm:px-2"
              >
                <CategoryIcon slug={row.icon} color={row.color} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {formatMoney(row.spentCents / 100)} spent
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={() => handleAddTargetFor(row.categoryId)}
                  disabled={setLineMutation.isPending}
                >
                  <IconPlus className="size-3.5" />
                  Add target
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* History report */}
      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <Card className="rounded-2xl shadow-sm">
          <CollapsibleTrigger asChild>
            <button type="button" className="w-full text-left">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div>
                  <CardTitle className="text-base">12-month history</CardTitle>
                  <CardDescription>Spend vs. target per budgeted category.</CardDescription>
                </div>
                <IconChevronDown className={cn("size-4 text-muted-foreground transition-transform", historyOpen && "rotate-180")} />
              </CardHeader>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-6">
              {historyQuery.isLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (historyQuery.data?.categories.length ?? 0) === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No budgeted categories with history yet.
                </p>
              ) : (
                historyQuery.data?.categories.map((cat) => {
                  const chartData = cat.series.map((s) => ({
                    month: s.month,
                    label: formatMonthLabel(s.month).replace(/ \d{4}$/, ""),
                    spend: s.spentCents / 100,
                    target: s.targetCents != null ? s.targetCents / 100 : null,
                  }));
                  return (
                    <div key={cat.categoryId} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <CategoryIcon slug={cat.icon} color={cat.color} />
                        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{cat.name}</h3>
                        <Link
                          to={`/spending?categoryId=${encodeURIComponent(cat.categoryId)}`}
                          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline decoration-dotted transition-colors hover:text-foreground"
                        >
                          Explore
                          <IconArrowUpRight className="size-3" />
                        </Link>
                      </div>
                      <div className="h-48 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={chartData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                            <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                            <YAxis
                              tickFormatter={(v) => formatMoneyCompact(Number(v))}
                              fontSize={11}
                              width={44}
                              tickLine={false}
                              axisLine={false}
                            />
                            <Tooltip formatter={(v: unknown) => formatMoney(Number(v ?? 0))} />
                            <Bar dataKey="spend" fill={cat.color ?? DEFAULT_CATEGORY_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} />
                            <Line
                              type="stepAfter"
                              dataKey="target"
                              stroke="hsl(var(--foreground))"
                              strokeWidth={2}
                              strokeDasharray="4 3"
                              dot={false}
                              connectNulls
                            />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  );
                })
              )}

              {/* Compact table fallback */}
              {(historyQuery.data?.categories.length ?? 0) > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        {historyQuery.data?.months.map((m) => (
                          <TableHead key={m} className="text-end">
                            {formatMonthLabel(m).replace(/ \d{4}$/, "")}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {historyQuery.data?.categories.map((cat) => (
                        <TableRow key={cat.categoryId}>
                          <TableCell className="font-medium">{cat.name}</TableCell>
                          {cat.series.map((s) => (
                            <TableCell key={s.month} className="text-end tabular-nums">
                              <span className={cn(s.targetCents != null && s.spentCents > s.targetCents ? "text-destructive" : undefined)}>
                                {formatMoney(s.spentCents / 100)}
                              </span>
                              {s.targetCents != null ? (
                                <span className="ms-1 text-xs text-muted-foreground">
                                  / {formatMoney(s.targetCents / 100)}
                                </span>
                              ) : null}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <p className="text-center text-xs text-muted-foreground">
        See also <Link to="/views" className="underline">saved views</Link> for other custom reports.
      </p>
    </div>
  );
}
