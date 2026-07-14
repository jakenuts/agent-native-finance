/**
 * /runway — cashflow runway: running-balance projection built from active
 * recurrings (get-runway action). Controls for horizon + optional daily
 * variable-spend estimate; a "pinch point" warning card when the balance
 * dips below $500 or negative; and a day-by-day ledger (empty days collapsed).
 */
import { useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBolt,
  IconCalendarStats,
  IconRepeat,
  IconShieldCheck,
  IconTrendingDown,
  IconTrendingUp,
} from "@tabler/icons-react";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { APP_TITLE } from "@/lib/app-config";
import { formatDate, formatMoney, formatMoneyCompact } from "@/lib/finance-format";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Runway - ${APP_TITLE}` }];
}

interface RunwayItem {
  recurringId: string | null;
  planId?: string;
  /** Set for projected-income ledger entries (kind 'projected'). */
  projectedId?: string;
  name: string;
  kind: "bill" | "subscription" | "income" | "plan" | "projected";
  amountCents: number;
  amount: number;
  critical?: boolean;
  /** True only when this plan item's own projected funding falls short. */
  warn?: boolean;
  /** True for projected-income entries — estimates, not promises. */
  estimate?: boolean;
}
interface RunwayDay {
  date: string;
  items: RunwayItem[];
  netCents: number;
  net: number;
  balanceCents: number;
  balance: number;
}
interface ProjectionBasis {
  incomeItems: number;
  billItems: number;
}
interface PlanFundingWarning {
  planId: string;
  name: string;
  nextDueDate: string;
  paymentCents: number;
  projectedBalanceAtDueCents: number;
  shortfallCents: number;
  payFromAccountName: string | null;
  projectionBasis: ProjectionBasis;
  fundingStatus?: "at_risk" | "unverified" | "ok";
  hasLinkedIncome?: boolean;
}
interface PlanFundingNote {
  planId: string;
  name: string;
  nextDueDate: string;
  paymentCents: number;
  projectedBalanceAtDueCents: number;
  payFromAccountName: string | null;
  fundingStatus: "at_risk" | "unverified" | "ok";
  hasLinkedIncome: boolean;
  householdCovered: boolean;
  householdProjectedCents: number;
}
interface PlanProjectedIncomeNote {
  planId: string;
  name: string;
  nextDueDate: string;
  paymentCents: number;
  projectedIncomeCents: number;
  payFromAccountName: string | null;
}
interface GetRunwayResult {
  startingBalanceCents: number;
  startingBalance: number;
  days: RunwayDay[];
  minBalanceCents: number;
  minBalance: number;
  minBalanceDate: string;
  negativeDates: string[];
  projectedIncomeCents: number;
  projectedIncome: number;
  projectedEntryCount: number;
  planProjectedIncomeNotes: PlanProjectedIncomeNote[];
  planFundingWarnings: PlanFundingWarning[];
  planFundingNotes: PlanFundingNote[];
}

const HORIZON_OPTIONS = [7, 14, 30, 60] as const;
const PINCH_THRESHOLD_CENTS = 50_000; // $500

/** Month + year heading for a day-by-day ledger group, e.g. "July 2026". */
function monthYearLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Bare day number for the narrow mobile Date column, e.g. "8". */
function dayNumberLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return String(d.getDate());
}

/** Fuller weekday + day for the desktop Date column, e.g. "Tue 8". */
function dayFullLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`;
}

/** Group consecutive ledger days by calendar month for the sticky month headers. */
function groupDaysByMonth(days: RunwayDay[]): { key: string; label: string; days: RunwayDay[] }[] {
  const groups: { key: string; label: string; days: RunwayDay[] }[] = [];
  for (const day of days) {
    const d = new Date(`${day.date}T00:00:00`);
    const key = Number.isNaN(d.getTime()) ? day.date.slice(0, 7) : `${d.getFullYear()}-${d.getMonth()}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.days.push(day);
    } else {
      groups.push({ key, label: monthYearLabel(day.date), days: [day] });
    }
  }
  return groups;
}

function ItemIcon({ kind, warn }: { kind: RunwayItem["kind"]; warn?: boolean }) {
  if (kind === "plan") {
    return <IconShieldCheck className={cn("size-3.5", warn ? "text-destructive" : "text-primary/70")} />;
  }
  if (kind === "projected") return <IconTrendingUp className="size-3.5 text-fin-positive/60" />;
  if (kind === "income") return <IconArrowUpRight className="size-3.5 text-fin-positive" />;
  if (kind === "subscription") return <IconRepeat className="size-3.5 text-muted-foreground" />;
  return <IconBolt className="size-3.5 text-muted-foreground" />;
}

export default function RunwayRoute() {
  useSetPageTitle("Runway");
  const [days, setDays] = useState<number>(30);
  const [includeVariable, setIncludeVariable] = useState(false);
  const [variableSpend, setVariableSpend] = useState<string>("0");

  const dailyVariableSpendCents = includeVariable
    ? Math.max(0, Math.round(Number(variableSpend || "0") * 100))
    : undefined;

  const runwayQuery = useActionQuery<GetRunwayResult>("get-runway", {
    days,
    ...(dailyVariableSpendCents != null ? { dailyVariableSpendCents } : {}),
  });

  const data = runwayQuery.data;

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.days.map((d) => ({
      date: d.date,
      label: formatDate(d.date).replace(/, \d{4}$/, ""),
      balance: d.balance,
    }));
  }, [data]);

  const activeDays = useMemo(() => (data ? data.days.filter((d) => d.items.length > 0) : []), [data]);
  const ledgerMonthGroups = useMemo(() => groupDaysByMonth(activeDays), [activeDays]);

  // Last date (within the loaded window) that has any projected-income item —
  // drives the "projections end" marker on the chart below.
  const lastProjectedDate = useMemo(() => {
    if (!data) return null;
    let last: string | null = null;
    for (const day of data.days) {
      if (day.items.some((item) => item.kind === "projected")) last = day.date;
    }
    return last;
  }, [data]);
  const showProjectionsEndMarker = useMemo(() => {
    if (!data || !lastProjectedDate) return false;
    const horizonEndDate = data.days[data.days.length - 1]?.date;
    return horizonEndDate != null && lastProjectedDate < horizonEndDate;
  }, [data, lastProjectedDate]);
  const projectionsEndLabel = useMemo(
    () => chartData.find((d) => d.date === lastProjectedDate)?.label,
    [chartData, lastProjectedDate],
  );

  const isPinch = data ? data.minBalanceCents < PINCH_THRESHOLD_CENTS : false;
  const pinchDay = data?.days.find((d) => d.date === data.minBalanceDate);
  const pinchBiggestItem = pinchDay
    ? [...pinchDay.items].sort((a, b) => b.amountCents - a.amountCents)[0]
    : null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Runway</h1>
          <p className="text-sm text-muted-foreground">
            Projected balance from recurring bills, subscriptions, and income.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-border p-1">
            {HORIZON_OPTIONS.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={days === opt ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setDays(opt)}
              >
                {opt}d
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="variable-spend" className="flex items-center gap-1.5 text-sm">
              <input
                id="variable-spend-toggle"
                type="checkbox"
                className="size-3.5"
                checked={includeVariable}
                onChange={(e) => setIncludeVariable(e.target.checked)}
              />
              Include daily spend estimate
            </Label>
            <Input
              id="variable-spend"
              type="number"
              min="0"
              step="1"
              disabled={!includeVariable}
              value={variableSpend}
              onChange={(e) => setVariableSpend(e.target.value)}
              className="h-8 w-24"
              placeholder="$/day"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Starting balance</CardDescription>
            {runwayQuery.isLoading ? (
              <Skeleton className="h-8 w-28" />
            ) : (
              <CardTitle className="text-2xl tabular-nums">
                {formatMoney(data?.startingBalance ?? 0)}
              </CardTitle>
            )}
          </CardHeader>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Lowest projected balance</CardDescription>
            {runwayQuery.isLoading ? (
              <Skeleton className="h-8 w-28" />
            ) : (
              <CardTitle
                className={cn(
                  "text-2xl tabular-nums",
                  (data?.minBalanceCents ?? 0) < 0 ? "text-destructive" : undefined,
                )}
              >
                {formatMoney(data?.minBalance ?? 0)}
              </CardTitle>
            )}
            {data ? (
              <p className="text-xs text-muted-foreground">on {formatDate(data.minBalanceDate)}</p>
            ) : null}
          </CardHeader>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Days negative</CardDescription>
            {runwayQuery.isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <CardTitle
                className={cn(
                  "text-2xl tabular-nums",
                  (data?.negativeDates.length ?? 0) > 0 ? "text-destructive" : undefined,
                )}
              >
                {data?.negativeDates.length ?? 0}
              </CardTitle>
            )}
          </CardHeader>
        </Card>
      </div>

      {!runwayQuery.isLoading && isPinch && data ? (
        <Card className="rounded-2xl border-destructive/40 bg-destructive/5 shadow-sm">
          <CardContent className="flex items-start gap-3 py-4">
            <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-destructive">
                Pinch point on {formatDate(data.minBalanceDate)}
              </p>
              <p className="text-sm text-muted-foreground">
                Projected balance drops to {formatMoney(data.minBalance)}
                {pinchBiggestItem
                  ? `, driven largely by ${pinchBiggestItem.name} (${formatMoney(Math.abs(pinchBiggestItem.amount))})`
                  : ""}
                .
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!runwayQuery.isLoading && (data?.planFundingWarnings.length ?? 0) > 0 ? (
        <Card className="rounded-2xl border-destructive/40 bg-destructive/5 shadow-sm">
          <CardContent className="space-y-2 py-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <IconShieldCheck className="size-4" />
              Payment plan funding warning
            </p>
            {data?.planFundingWarnings.map((w) => (
              <div key={w.planId} className="text-sm text-muted-foreground">
                <p>
                  <strong className="text-foreground">{w.name}</strong> needs {formatMoney(w.paymentCents / 100)} in{" "}
                  {w.payFromAccountName ?? "its pay-from account"} by {formatDate(w.nextDueDate)} — projected
                  balance {formatMoney(w.projectedBalanceAtDueCents / 100)}, short{" "}
                  {formatMoney(w.shortfallCents / 100)}.{" "}
                  <Link to="/plans" className="underline">
                    Review plans
                  </Link>
                </p>
                {!w.hasLinkedIncome ? (
                  <p className="text-xs text-destructive/80">
                    No income linked to that account before the due date — this projection assumes none arrives.
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {!runwayQuery.isLoading && (data?.projectedIncomeCents ?? 0) > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <IconTrendingUp className="size-3.5 text-fin-positive/70" />
          Includes {formatMoney((data?.projectedIncomeCents ?? 0) / 100)} of projected income (
          {data?.projectedEntryCount} expected renewal
          {(data?.projectedEntryCount ?? 0) === 1 ? "" : "s"}) in this window — estimates, not
          promises.{" "}
          <Link to="/projections" className="underline">
            Manage projections
          </Link>
        </p>
      ) : null}

      {!runwayQuery.isLoading && (data?.planProjectedIncomeNotes?.length ?? 0) > 0 ? (
        <Card className="rounded-2xl border-fin-warning/40 bg-fin-warning/5 shadow-sm">
          <CardContent className="space-y-2 py-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-fin-warning">
              <IconTrendingUp className="size-4" />
              Plan funding relies on projected income
            </p>
            {data?.planProjectedIncomeNotes.map((n) => (
              <p key={n.planId} className="text-sm text-muted-foreground">
                <strong className="text-foreground">{n.name}</strong> ({formatMoney(n.paymentCents / 100)}{" "}
                due {formatDate(n.nextDueDate)}
                {n.payFromAccountName ? ` from ${n.payFromAccountName}` : ""}) relies on{" "}
                {formatMoney(n.projectedIncomeCents / 100)} of projected renewals arriving first —
                these are estimates, so keep an eye on{" "}
                <Link to="/projections" className="underline">
                  the projections ledger
                </Link>
                .
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {!runwayQuery.isLoading && (data?.planFundingNotes.length ?? 0) > 0 ? (
        <Card className="rounded-2xl border-fin-warning/40 bg-fin-warning/5 shadow-sm">
          <CardContent className="space-y-2 py-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-fin-warning">
              <IconShieldCheck className="size-4" />
              Payment plans to double-check
            </p>
            {data?.planFundingNotes.map((n) => (
              <div key={n.planId} className="text-sm text-muted-foreground">
                {n.householdCovered ? (
                  <p>
                    <strong className="text-foreground">{n.name}</strong> — funds available across your
                    accounts ({formatMoney(n.householdProjectedCents / 100)}); move{" "}
                    {formatMoney(n.paymentCents / 100)} to {n.payFromAccountName ?? "the pay-from account"} by{" "}
                    {formatDate(n.nextDueDate)}.{" "}
                    <Link to="/plans" className="underline">
                      Review plans
                    </Link>
                  </p>
                ) : (
                  <p>
                    <strong className="text-foreground">{n.name}</strong> — can't verify funding: no income is
                    linked to {n.payFromAccountName ?? "its pay-from account"}.{" "}
                    <Link to="/recurring" className="underline">
                      Link your paycheck's deposit account
                    </Link>{" "}
                    for accurate projections.
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <IconCalendarStats className="size-4 text-muted-foreground" />
            Running balance
          </CardTitle>
          <CardDescription>Zero line marks running out of money.</CardDescription>
        </CardHeader>
        <CardContent>
          {runwayQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="runwayPositive" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="runwayNegative" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--destructive))" stopOpacity={0.05} />
                      <stop offset="100%" stopColor="hsl(var(--destructive))" stopOpacity={0.35} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis
                    tickFormatter={(v) => formatMoneyCompact(Number(v))}
                    fontSize={11}
                    width={48}
                    tickLine={false}
                    axisLine={false}
                  />
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
                    strokeWidth={2.5}
                    fill="url(#runwayPositive)"
                    isAnimationActive={false}
                  />
                  {data ? (
                    <ReferenceDot
                      x={chartData.find((d) => d.date === data.minBalanceDate)?.label}
                      y={data.minBalance}
                      r={5}
                      fill="hsl(var(--destructive))"
                      stroke="white"
                      strokeWidth={2}
                    />
                  ) : null}
                  {showProjectionsEndMarker && projectionsEndLabel ? (
                    <ReferenceLine
                      x={projectionsEndLabel}
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="4 3"
                      strokeOpacity={0.6}
                      label={{
                        value: "projections end",
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                    />
                  ) : null}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Day-by-day ledger</CardTitle>
          <CardDescription>Only days with activity are shown.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {runwayQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : activeDays.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No projected bills, subscriptions, or income in this window. Add some on{" "}
              <Link to="/recurring" className="underline">
                /recurring
              </Link>
              .
            </p>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto sm:max-h-[75vh] lg:max-h-[80vh]">
              <table className="w-full border-collapse text-sm [table-layout:fixed]">
                <colgroup>
                  <col className="w-10 sm:w-20" />
                  <col />
                  <col className="hidden w-28 sm:table-column" />
                  <col className="w-20 sm:w-28" />
                </colgroup>
                <thead className="sticky top-0 z-20 bg-card shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium sm:px-3">Date</th>
                    <th className="px-2 py-2 text-left font-medium sm:px-3">Items</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Day net</th>
                    <th className="px-2 py-2 text-right font-medium sm:px-3">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerMonthGroups.map((group) => (
                    <Fragment key={group.key}>
                      <tr>
                        <td
                          colSpan={4}
                          className="sticky top-8 z-10 border-b border-border/60 bg-muted/70 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-sm sm:px-3"
                        >
                          {group.label}
                        </td>
                      </tr>
                      {group.days.map((day, dayIdx) => {
                        const rowBg =
                          day.balanceCents < 0
                            ? "bg-destructive/5"
                            : dayIdx % 2 === 1
                              ? "bg-muted/20"
                              : "bg-card";
                        return (
                      <tr key={day.date} className="border-b border-border/60 align-top last:border-b-0">
                        <td className={cn("px-2 py-2.5 text-xs font-medium tabular-nums sm:px-3 sm:text-sm sm:whitespace-nowrap", rowBg)}>
                          <span className="sm:hidden">{dayNumberLabel(day.date)}</span>
                          <span className="hidden sm:inline">{dayFullLabel(day.date)}</span>
                        </td>
                        <td className={cn("overflow-hidden px-2 py-2.5 sm:px-3", rowBg)}>
                          <div className="space-y-1.5">
                            {day.items.map((item) => {
                              const isProjected = item.kind === "projected";
                              const isInflow = isProjected
                                ? item.amountCents < 0
                                : item.kind === "income";
                              return (
                              <Link
                                key={item.planId ?? item.projectedId ?? item.recurringId ?? item.name}
                                to={
                                  item.kind === "plan"
                                    ? "/plans"
                                    : isProjected
                                      ? "/projections"
                                      : "/recurring"
                                }
                                className={cn(
                                  "flex items-center gap-1.5 rounded px-1 py-0.5 -mx-1 transition-colors hover:bg-accent/60 sm:gap-2",
                                  item.kind === "plan"
                                    ? item.warn
                                      ? "border-l-2 border-destructive/50"
                                      : "border-l-2 border-primary/40"
                                    : undefined,
                                  // Projected entries are estimates — ghosted +
                                  // dashed to read as "penciled in".
                                  isProjected
                                    ? "border-l-2 border-dashed border-fin-positive/40 opacity-70"
                                    : undefined,
                                )}
                              >
                                <ItemIcon kind={item.kind} warn={item.warn} />
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate text-foreground",
                                    isProjected ? "italic" : undefined,
                                  )}
                                >
                                  {item.name}
                                </span>
                                {item.kind === "plan" ? (
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "hidden shrink-0 text-[9px] uppercase sm:inline-flex",
                                      item.warn
                                        ? "text-destructive border-destructive/40"
                                        : "text-muted-foreground border-border",
                                    )}
                                  >
                                    Plan
                                  </Badge>
                                ) : null}
                                {isProjected ? (
                                  <Badge
                                    variant="outline"
                                    className="hidden shrink-0 border-dashed border-fin-positive/40 text-[9px] uppercase text-fin-positive/80 sm:inline-flex"
                                  >
                                    Projected
                                  </Badge>
                                ) : null}
                                <span
                                  className={cn(
                                    "hidden shrink-0 text-end tabular-nums sm:inline",
                                    isInflow ? "text-fin-positive" : "text-destructive",
                                    isProjected ? "opacity-80" : undefined,
                                  )}
                                >
                                  {isInflow ? "+" : "-"}
                                  {formatMoney(Math.abs(item.amount))}
                                </span>
                              </Link>
                              );
                            })}
                          </div>
                        </td>
                        <td className={cn("hidden px-3 py-2.5 text-right align-middle sm:table-cell", rowBg)}>
                          <span
                            className={cn(
                              "tabular-nums",
                              day.netCents < 0 ? "text-destructive" : "text-fin-positive",
                            )}
                          >
                            {day.net >= 0 ? "+" : ""}
                            {formatMoney(day.net)}
                          </span>
                        </td>
                        <td className={cn("px-2 py-2.5 text-right align-middle sm:px-3", rowBg)}>
                          <span
                            className={cn(
                              "text-xs font-semibold tabular-nums sm:text-sm",
                              day.balanceCents < 0 ? "text-destructive" : undefined,
                            )}
                          >
                            {formatMoney(day.balance)}
                          </span>
                        </td>
                      </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {!runwayQuery.isLoading && (data?.negativeDates.length ?? 0) === 0 && !isPinch ? (
        <p className="flex items-center justify-center gap-1.5 text-center text-sm text-muted-foreground">
          <IconTrendingDown className="size-4" />
          No pinch points projected in this window.
        </p>
      ) : null}
    </div>
  );
}
