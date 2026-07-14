import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconArrowUpRight,
  IconBolt,
  IconCalendarStats,
  IconChartPie,
  IconChevronRight,
  IconPigMoney,
  IconPin,
  IconRefresh,
  IconRepeat,
  IconShieldCheck,
  IconWallet,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { CategoryChip } from "@/components/finance/CategoryChip";
import { CategoryAvatar, MerchantAvatar } from "@/components/finance/MerchantAvatar";
import { TransactionDetail } from "@/components/finance/TransactionDetail";
import {
  SavedViewCard,
  type SavedViewConfig,
} from "@/components/finance/SavedViewCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_CATEGORY_COLOR } from "@/lib/category-icons";
import {
  formatDate,
  formatMoney,
  formatMonthLabel,
  formatSignedMoney,
} from "@/lib/finance-format";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Dashboard - ${APP_TITLE}` }];
}

interface CategoryQueryRow {
  key: string;
  label: string;
  valueCents: number;
  count: number;
}
interface DayQueryRow {
  key: string;
  label: string;
  valueCents: number;
  count: number;
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
interface ListSavedViewsResult {
  views: Array<{
    id: string;
    name: string;
    description: string | null;
    kind: string;
    config: SavedViewConfig | null;
    position: number;
    isPinned: boolean;
  }>;
}
interface UpcomingBillItem {
  date: string;
  recurringId: string;
  name: string;
  kind: "bill" | "subscription" | "income";
  amountCents: number;
  amount: number;
}
interface UpcomingBillsResult {
  items: UpcomingBillItem[];
  totalCents: number;
  total: number;
}
interface RunwayDay {
  date: string;
  balance: number;
  balanceCents: number;
}
interface GetRunwayResult {
  startingBalance: number;
  days: RunwayDay[];
  minBalance: number;
  minBalanceCents: number;
  minBalanceDate: string;
  negativeDates: string[];
}
interface PlanFundingInfo {
  /** Back-compat alias for projectedFunded. */
  funded: boolean;
  snapshotFundedNow: boolean;
  projectedBalanceAtDueCents: number;
  projectedFunded: boolean;
  shortfallCents: number;
  payFromAccountName: string | null;
  fundingStatus: "at_risk" | "unverified" | "ok";
  hasLinkedIncome: boolean;
  householdCovered: boolean;
}
interface PlanRow {
  id: string;
  name: string;
  payment: number;
  nextDueDate: string;
  daysUntil: number;
  /** NET severity: red only when at_risk AND household can't cover. */
  warn: boolean;
  householdCovered: boolean;
  funding: PlanFundingInfo;
}
interface ListPaymentPlansResult {
  plans: PlanRow[];
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
interface GetBudgetResult {
  budgeted: BudgetedRow[];
  rollup: { totalTargetCents: number; totalSpentCents: number; remainingCents: number };
}

/** Cumulative-by-day series for an area chart, built from grouped day rows. */
function buildCumulativeSeries(rows: DayQueryRow[] | undefined): Array<{ day: number; total: number }> {
  if (!rows || rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  let running = 0;
  return sorted.map((r) => {
    running += r.valueCents / 100;
    const day = Number(r.key.slice(-2));
    return { day, total: running };
  });
}

export default function DashboardRoute() {
  useSetPageTitle("Dashboard");
  const navigate = useNavigate();
  const [detailId, setDetailId] = useState<string | null>(null);

  const accountsQuery = useActionQuery("list-accounts", {});
  const summaryQuery = useActionQuery("spending-summary", {});
  const recentQuery = useActionQuery("list-transactions", { limit: 8 });
  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {});
  const viewsQuery = useActionQuery<ListSavedViewsResult>("list-saved-views", {});
  const syncMutation = useActionMutation("plaid-sync");
  const upcomingBillsQuery = useActionQuery<UpcomingBillsResult>("upcoming-bills", { days: 7 });
  const runwayQuery = useActionQuery<GetRunwayResult>("get-runway", { days: 30 });
  const budgetQuery = useActionQuery<GetBudgetResult>("get-budget", {});
  const plansQuery = useActionQuery<ListPaymentPlansResult>("list-payment-plans", { status: "active" });

  const thisMonthDaily = useActionQuery<{ rows: DayQueryRow[] }>("run-finance-query", {
    query: JSON.stringify({
      from: "transactions",
      filters: { month: "current", minCents: 1 },
      groupBy: "day",
      metric: "sum",
      limit: 31,
    }),
  });
  const lastMonthDaily = useActionQuery<{ rows: DayQueryRow[] }>("run-finance-query", {
    query: JSON.stringify({
      from: "transactions",
      filters: { month: "last", minCents: 1 },
      groupBy: "day",
      metric: "sum",
      limit: 31,
    }),
  });

  const catById = useMemo(() => {
    const map = new Map<string, CategoryOption>();
    for (const c of categoriesQuery.data?.categories ?? []) map.set(c.id, c);
    return map;
  }, [categoriesQuery.data]);

  const hasAccounts = (accountsQuery.data?.length ?? 0) > 0;

  const totalSpend = summaryQuery.data?.totalSpend ?? 0;
  const lastMonthTotal = useMemo(() => {
    const rows = lastMonthDaily.data?.rows ?? [];
    return rows.reduce((sum, r) => sum + r.valueCents / 100, 0);
  }, [lastMonthDaily.data]);
  const spendDelta = totalSpend - lastMonthTotal;
  const spendDeltaPct = lastMonthTotal > 0 ? (spendDelta / lastMonthTotal) * 100 : null;

  const chartData = useMemo(() => {
    const thisSeries = buildCumulativeSeries(thisMonthDaily.data?.rows);
    const lastSeries = buildCumulativeSeries(lastMonthDaily.data?.rows);
    const maxLen = Math.max(thisSeries.length, lastSeries.length, 1);
    const lastThisTotal = thisSeries.length > 0 ? thisSeries[thisSeries.length - 1].total : null;
    const out: Array<{ day: number; thisMonth: number | null; lastMonth: number | null }> = [];
    for (let i = 0; i < maxLen; i++) {
      out.push({
        day: i + 1,
        thisMonth: thisSeries[i]?.total ?? (i < thisSeries.length ? null : lastThisTotal),
        lastMonth: lastSeries[i]?.total ?? null,
      });
    }
    return out;
  }, [thisMonthDaily.data, lastMonthDaily.data]);

  const donutData = useMemo(() => {
    return (summaryQuery.data?.byCategory ?? []).slice(0, 6).map((c) => ({
      ...c,
      color: (c.categoryId ? catById.get(c.categoryId)?.color : null) ?? DEFAULT_CATEGORY_COLOR,
    }));
  }, [summaryQuery.data, catById]);

  const totalBreakdown = donutData.reduce((s, c) => s + c.spendDollars, 0);

  const pinnedViews = (viewsQuery.data?.views ?? []).filter((v) => v.isPinned);

  const attentionPlans = useMemo(
    () => (plansQuery.data?.plans ?? []).filter((p) => p.daysUntil <= 10 || p.warn),
    [plansQuery.data],
  );
  const hasAlarmingPlan = attentionPlans.some((p) => p.warn || p.daysUntil <= 3);

  const assetsTotal = useMemo(() => {
    let assets = 0;
    let debts = 0;
    for (const inst of accountsQuery.data ?? []) {
      for (const acct of inst.accounts) {
        if (acct.type === "credit" || acct.type === "loan") debts += acct.currentBalance ?? 0;
        else assets += acct.currentBalance ?? 0;
      }
    }
    return { assets, debts };
  }, [accountsQuery.data]);

  function handleSync() {
    syncMutation.mutate(
      {},
      {
        onSuccess: (result) => {
          toast.success(`Synced ${result.changed} transaction change${result.changed === 1 ? "" : "s"}`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Sync failed");
        },
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {summaryQuery.data ? formatMonthLabel(summaryQuery.data.month) : "This month"} at a glance.
          </p>
        </div>
        <Button onClick={handleSync} disabled={syncMutation.isPending} size="sm">
          <IconRefresh className={syncMutation.isPending ? "size-4 animate-spin" : "size-4"} />
          {syncMutation.isPending ? "Syncing..." : "Sync now"}
        </Button>
      </div>

      {!accountsQuery.isLoading && !hasAccounts ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No accounts connected yet</CardTitle>
            <CardDescription>
              Connect a bank to start tracking balances, spending, and trends.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link to="/connect">Connect a bank</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Current Spend hero card */}
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Current spend</CardDescription>
            <div className="flex items-baseline gap-3">
              {summaryQuery.isLoading ? (
                <Skeleton className="h-9 w-32" />
              ) : (
                <CardTitle className="text-3xl tabular-nums">{formatMoney(totalSpend)}</CardTitle>
              )}
              {spendDeltaPct != null ? (
                <span
                  className={
                    spendDelta >= 0
                      ? "inline-flex items-center gap-1 rounded-full bg-fin-warning/15 px-2 py-0.5 text-xs font-medium text-fin-warning"
                      : "inline-flex items-center gap-1 rounded-full bg-fin-positive/15 px-2 py-0.5 text-xs font-medium text-fin-positive"
                  }
                >
                  {spendDelta >= 0 ? (
                    <IconArrowUp className="size-3" />
                  ) : (
                    <IconArrowDown className="size-3" />
                  )}
                  {formatMoney(Math.abs(spendDelta))} {spendDelta >= 0 ? "more" : "less"} than last month
                </span>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {thisMonthDaily.isLoading || lastMonthDaily.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="thisMonthGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="day"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(d) => String(d)}
                      minTickGap={24}
                    />
                    <Tooltip
                      formatter={(v: unknown, name: unknown) => [
                        formatMoney(Number(v ?? 0)),
                        name === "thisMonth" ? "This month" : "Last month",
                      ]}
                      labelFormatter={(d) => `Day ${d}`}
                    />
                    <Area
                      type="monotone"
                      dataKey="lastMonth"
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="4 3"
                      strokeWidth={1.5}
                      fill="none"
                    />
                    <Area
                      type="monotone"
                      dataKey="thisMonth"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2.5}
                      fill="url(#thisMonthGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Spending Breakdown */}
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-base">Spending breakdown</CardTitle>
              <CardDescription>
                {summaryQuery.data ? formatMonthLabel(summaryQuery.data.month) : ""}
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/spending">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {summaryQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : donutData.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No spending recorded this month.
              </p>
            ) : (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="relative mx-auto size-40 shrink-0 sm:mx-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={donutData}
                        dataKey="spendDollars"
                        nameKey="category"
                        innerRadius="68%"
                        outerRadius="100%"
                        paddingAngle={2}
                        stroke="none"
                      >
                        {donutData.map((c, i) => (
                          <Cell key={i} fill={c.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: unknown) => formatMoney(Number(v))} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-lg font-semibold tabular-nums">
                      {formatMoney(totalBreakdown)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">total</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  {donutData.map((c) => (
                    <button
                      key={c.category}
                      type="button"
                      onClick={() =>
                        navigate(
                          c.categoryId
                            ? `/spending?categoryId=${encodeURIComponent(c.categoryId)}`
                            : "/spending",
                        )
                      }
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-accent/60"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{c.category}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {totalBreakdown > 0 ? Math.round((c.spendDollars / totalBreakdown) * 100) : 0}%
                      </span>
                      <span className="w-16 shrink-0 text-end text-sm font-medium tabular-nums">
                        {formatMoney(c.spendDollars)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Recent transactions */}
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Recent transactions</CardTitle>
              <CardDescription>Latest activity across all accounts.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/transactions">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {recentQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : (recentQuery.data?.rows.length ?? 0) === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No transactions yet.</p>
            ) : (
              recentQuery.data?.rows.map((tx) => (
                <div
                  key={tx.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailId(tx.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDetailId(tx.id);
                    }
                  }}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50"
                >
                  <CategoryAvatar
                    categoryId={tx.categoryId}
                    icon={tx.categoryId ? catById.get(tx.categoryId)?.icon : null}
                    color={tx.categoryId ? catById.get(tx.categoryId)?.color : null}
                    fallbackName={tx.merchantName || tx.name}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const name = (tx.merchantName || tx.name || "").trim();
                        if (!name) return;
                        navigate(`/spending?merchant=${encodeURIComponent(name)}`);
                      }}
                      className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                    >
                      {tx.merchantName || tx.name || "Unknown"}
                    </button>
                    <div
                      className="flex min-w-0 items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDate(tx.date)}</span>
                      <CategoryChip
                        transactionId={tx.id}
                        categoryId={tx.categoryId}
                        categoryName={tx.category}
                      />
                    </div>
                  </div>
                  <span
                    className={
                      tx.amount < 0
                        ? "shrink-0 text-sm font-semibold tabular-nums text-fin-positive"
                        : "shrink-0 text-sm font-semibold tabular-nums"
                    }
                  >
                    {formatSignedMoney(tx.amount)}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Accounts summary */}
        <Card className="flex flex-col rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Accounts</CardTitle>
              <CardDescription>Assets vs. debts across connected banks.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/accounts">Manage</Link>
            </Button>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col space-y-3">
            {accountsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : !hasAccounts ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No accounts connected yet.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-fin-positive/10 p-3">
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <IconWallet className="size-3.5" />
                      Assets
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-fin-positive">
                      {formatMoney(assetsTotal.assets)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-fin-negative/10 p-3">
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <IconArrowUpRight className="size-3.5" />
                      Debts
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-fin-negative">
                      {formatMoney(assetsTotal.debts)}
                    </p>
                  </div>
                </div>
                {/* Fills the card's remaining height (grid rows stretch to the
                    tallest sibling) instead of clipping at a fixed cap with
                    dead space below; max-h keeps it bounded if this card is
                    the tallest in its row. */}
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-1 pe-1 [max-height:28rem]">
                  {(accountsQuery.data ?? []).flatMap((inst) =>
                    inst.accounts.map((acct) => {
                      // Depository (checking/savings) accounts lead with the
                      // spendable `available` balance, matching bank apps —
                      // see isDepositoryAsset/BalanceDisplay in accounts.tsx
                      // for the same rule (CDs excluded — funds are locked,
                      // no "available to spend" concept).
                      const isDepositoryAssetAccount =
                        acct.type === "depository" && acct.subtype !== "cd";
                      const headline =
                        isDepositoryAssetAccount && acct.availableBalance != null
                          ? acct.availableBalance
                          : acct.currentBalance;
                      return (
                        <Link
                          key={acct.id}
                          to={`/transactions?accountId=${acct.id}`}
                          className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-accent/60"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <MerchantAvatar name={inst.name} size="sm" />
                            <span className="min-w-0 truncate text-muted-foreground">
                              {acct.name ?? "Account"}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className="font-medium tabular-nums">
                              {formatMoney(headline)}
                            </span>
                            <IconChevronRight className="size-4 text-muted-foreground" />
                          </div>
                        </Link>
                      );
                    }),
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Upcoming bills */}
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Upcoming bills</CardTitle>
              <CardDescription>Next 7 days.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/recurring">Manage</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {upcomingBillsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (upcomingBillsQuery.data?.items.length ?? 0) === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No upcoming bills in the next 7 days.
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  {(upcomingBillsQuery.data?.items ?? []).slice(0, 6).map((item, i) => (
                    <Link
                      key={`${item.recurringId}-${item.date}-${i}`}
                      to="/recurring"
                      className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-accent/60"
                    >
                      {item.kind === "income" ? (
                        <IconArrowUpRight className="size-4 shrink-0 text-fin-positive" />
                      ) : item.kind === "subscription" ? (
                        <IconRepeat className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <IconBolt className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDate(item.date)}</span>
                      <span
                        className={
                          item.kind === "income"
                            ? "w-16 shrink-0 text-end font-medium tabular-nums text-fin-positive"
                            : "w-16 shrink-0 text-end font-medium tabular-nums"
                        }
                      >
                        {item.kind === "income" ? "+" : "-"}
                        {formatMoney(Math.abs(item.amount))}
                      </span>
                    </Link>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-2 text-sm">
                  <span className="text-muted-foreground">Net over 7 days</span>
                  <span className="font-semibold tabular-nums">
                    {formatMoney(-(upcomingBillsQuery.data?.total ?? 0))}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Runway sparkline */}
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Runway</CardTitle>
              <CardDescription>30-day projected balance.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/runway">
                <IconCalendarStats className="size-4" />
                Details
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {runwayQuery.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <>
                <div className="h-32 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={runwayQuery.data?.days ?? []}
                      margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="dashRunwayGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeDasharray="4 3" />
                      <Tooltip
                        formatter={(v: unknown) => formatMoney(Number(v))}
                        labelFormatter={(_l, payload) =>
                          payload?.[0]?.payload?.date ? formatDate(payload[0].payload.date) : ""
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="balance"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        fill="url(#dashRunwayGradient)"
                        isAnimationActive={false}
                      />
                      {runwayQuery.data ? (
                        <ReferenceDot
                          x={runwayQuery.data.minBalanceDate}
                          y={runwayQuery.data.minBalance}
                          r={4}
                          fill="hsl(var(--destructive))"
                          stroke="white"
                          strokeWidth={2}
                        />
                      ) : null}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Lowest {formatDate(runwayQuery.data?.minBalanceDate ?? null)}
                  </span>
                  <span
                    className={
                      (runwayQuery.data?.minBalanceCents ?? 0) < 0
                        ? "font-semibold tabular-nums text-destructive"
                        : "font-semibold tabular-nums"
                    }
                  >
                    {formatMoney(runwayQuery.data?.minBalance ?? 0)}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Payment plans summary — lives below the runway since upcoming bills
          and the runway already surface plan payments; this is the drill-in. */}
      {attentionPlans.length > 0 ? (
        <Card
          className={cn(
            "rounded-2xl shadow-sm",
            hasAlarmingPlan ? "border-destructive/30" : undefined,
          )}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <IconShieldCheck className={cn("size-4", hasAlarmingPlan ? "text-destructive" : "text-muted-foreground")} />
                Payment plans
              </CardTitle>
              <CardDescription>
                Due soon — these are critical, never-miss bills.
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/plans">Manage</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {attentionPlans.map((plan) => {
              const isAlarming = plan.warn || plan.daysUntil <= 3;
              const isHouseholdCovered = !plan.warn && plan.funding.householdCovered;
              const isUnverified =
                !plan.warn && !isHouseholdCovered && plan.funding.fundingStatus === "unverified";
              const isReassuring = !plan.funding.snapshotFundedNow && plan.funding.projectedFunded;
              return (
                <Link
                  key={plan.id}
                  to="/plans"
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-accent/60"
                >
                  <span className="min-w-0 flex-1 truncate">{plan.name}</span>
                  <Badge
                    variant="secondary"
                    className={
                      isAlarming
                        ? "bg-destructive/15 text-destructive"
                        : plan.daysUntil <= 7
                          ? "bg-fin-warning/15 text-fin-warning"
                          : "bg-secondary text-secondary-foreground"
                    }
                  >
                    {plan.daysUntil <= 0 ? "due now" : `in ${plan.daysUntil}d`}
                  </Badge>
                  {plan.warn ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
                      <IconAlertTriangle className="size-3.5" />
                      Short {formatMoney(plan.funding.shortfallCents / 100)}
                    </span>
                  ) : isHouseholdCovered ? (
                    <span className="shrink-0 text-xs text-fin-warning">Move funds</span>
                  ) : isUnverified ? (
                    <span className="shrink-0 text-xs text-fin-warning">Link income</span>
                  ) : isReassuring ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Projected funded</span>
                  ) : (
                    <span className="shrink-0 text-xs text-fin-positive">Funded</span>
                  )}
                  <span className="w-16 shrink-0 text-end font-medium tabular-nums">
                    {formatMoney(plan.payment)}
                  </span>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Budgets summary */}
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <IconPigMoney className="size-4 text-muted-foreground" />
                Budgets
              </CardTitle>
              <CardDescription>Top categories by % of target used.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/budgets">Manage</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {budgetQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (budgetQuery.data?.budgeted.length ?? 0) === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No budgets set this month.{" "}
                <Link to="/budgets" className="underline">
                  Set up budgets
                </Link>
                .
              </p>
            ) : (
              <>
                <div className="space-y-2.5">
                  {[...(budgetQuery.data?.budgeted ?? [])]
                    .sort((a, b) => b.pctUsed - a.pctUsed)
                    .slice(0, 4)
                    .map((row) => (
                      <Link
                        key={row.categoryId}
                        to="/budgets"
                        className="block rounded-md px-1.5 py-1 transition-colors hover:bg-accent/60"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                          <span className="min-w-0 truncate">{row.name}</span>
                          <span
                            className={
                              row.pctUsed > 100
                                ? "shrink-0 tabular-nums text-destructive"
                                : "shrink-0 tabular-nums text-muted-foreground"
                            }
                          >
                            {formatMoney(row.spentCents / 100)} / {formatMoney(row.targetCents / 100)}
                          </span>
                        </div>
                        <Progress
                          value={Math.min(100, row.pctUsed)}
                          className={
                            row.pctUsed > 100
                              ? "h-1.5 [&>div]:bg-destructive"
                              : row.pctUsed >= 80
                                ? "h-1.5 [&>div]:bg-fin-warning"
                                : "h-1.5 [&>div]:bg-fin-positive"
                          }
                        />
                      </Link>
                    ))}
                </div>
                <div className="flex items-center justify-between border-t border-border/60 px-1.5 pt-2 text-sm">
                  <span className="text-muted-foreground">Remaining this month</span>
                  <span
                    className={
                      (budgetQuery.data?.rollup.remainingCents ?? 0) < 0
                        ? "font-semibold tabular-nums text-destructive"
                        : "font-semibold tabular-nums"
                    }
                  >
                    {formatMoney((budgetQuery.data?.rollup.remainingCents ?? 0) / 100)}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {pinnedViews.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconPin className="size-4 text-muted-foreground" />
              <h2 className="text-base font-semibold tracking-tight">Agent views</h2>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/views">
                <IconChartPie className="size-4" />
                All views
              </Link>
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {pinnedViews.map((view) => (
              <SavedViewCard
                key={view.id}
                view={{
                  id: view.id,
                  name: view.name,
                  description: view.description,
                  kind: view.kind,
                  config: view.config,
                  isPinned: view.isPinned,
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <TransactionDetail
        transactionId={detailId}
        open={detailId !== null}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
    </div>
  );
}
