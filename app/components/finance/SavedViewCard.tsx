/**
 * Renders one saved view (fp_saved_views row): runs its query through the
 * run-finance-query action and presents the result as a chart (bar/line/
 * area/pie/donut), a compact table, or a big-number metric card.
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { IconPin, IconPinnedOff } from "@tabler/icons-react";
import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatMoney, formatMoneyCompact, formatMonthLabel } from "@/lib/finance-format";

const PALETTE = [
  "#60a5fa",
  "#f97316",
  "#4ade80",
  "#c084fc",
  "#f472b6",
  "#facc15",
  "#2dd4bf",
  "#ef4444",
  "#818cf8",
  "#a8a29e",
];

export interface SavedViewRow {
  id: string;
  name: string;
  description: string | null;
  kind: string; // 'chart' | 'table' | 'metric'
  config: SavedViewConfig | null;
  isPinned: boolean;
}

export interface SavedViewConfig {
  query: Record<string, unknown> & {
    filters?: Record<string, unknown>;
    groupBy?: string;
  };
  chart?: { type: "bar" | "line" | "area" | "pie" | "donut"; xKey?: string; yLabel?: string };
  table?: { columns?: string[] };
  metric?: { format?: "currency" | "number"; compareMonth?: boolean };
}

interface GroupRow {
  key: string;
  label: string;
  valueCents: number;
  count: number;
}

interface QueryResult {
  groupBy: string | null;
  metric: string;
  rowCount: number;
  rows: GroupRow[] | Array<Record<string, unknown>>;
}

function isGroupRows(result: QueryResult | undefined): result is QueryResult & { rows: GroupRow[] } {
  return Boolean(result && result.groupBy);
}

function monthLabelIfMonth(groupBy: string | null | undefined, label: string): string {
  if (groupBy === "month" && /^\d{4}-\d{2}$/.test(label)) {
    return formatMonthLabel(label).replace(/(\w{3})\w* (\d{4})/, "$1 $2");
  }
  return label;
}

/** Build the previous-period variant of a query for MoM compare. */
function previousMonthQuery(query: SavedViewConfig["query"]): SavedViewConfig["query"] | null {
  const month = query.filters?.month;
  if (month === "current") {
    return { ...query, filters: { ...query.filters, month: "last" } };
  }
  return null;
}

function sumCents(result: QueryResult | undefined): number {
  if (!result) return 0;
  if (isGroupRows(result)) {
    return result.rows.reduce((total, r) => total + (r.valueCents ?? 0), 0);
  }
  return (result.rows as Array<Record<string, unknown>>).reduce(
    (total, r) => total + Number(r.amountCents ?? 0),
    0,
  );
}

function ChartBody({ result, config }: { result: QueryResult; config: SavedViewConfig }) {
  const type = config.chart?.type ?? "bar";
  const data = useMemo(() => {
    if (!isGroupRows(result)) return [];
    return result.rows.map((r) => ({
      label: monthLabelIfMonth(result.groupBy, r.label),
      value: r.valueCents / 100,
    }));
  }, [result]);

  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No data.</p>;
  }

  const money = (v: unknown) => formatMoney(Number(v));

  if (type === "pie" || type === "donut") {
    return (
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={type === "donut" ? "55%" : 0}
              outerRadius="85%"
              paddingAngle={1}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip formatter={money} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const common = {
    data,
    margin: { left: 8, right: 16, top: 4, bottom: 4 },
  };
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="label" fontSize={12} tickLine={false} />
      <YAxis tickFormatter={(v) => formatMoneyCompact(Number(v))} fontSize={12} width={52} />
      <Tooltip formatter={money} />
    </>
  );

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {type === "line" ? (
          <LineChart {...common}>
            {axes}
            <Line type="monotone" dataKey="value" stroke={PALETTE[0]} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        ) : type === "area" ? (
          <AreaChart {...common}>
            {axes}
            <Area type="monotone" dataKey="value" stroke={PALETTE[0]} fill={PALETTE[0]} fillOpacity={0.25} strokeWidth={2} />
          </AreaChart>
        ) : (
          <BarChart {...common}>
            {axes}
            <Bar dataKey="value" fill={PALETTE[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function TableBody({ result }: { result: QueryResult }) {
  if (isGroupRows(result)) {
    if (result.rows.length === 0) {
      return <p className="py-10 text-center text-sm text-muted-foreground">No data.</p>;
    }
    return (
      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 pe-2 text-start font-medium">Name</th>
              <th className="py-1.5 pe-2 text-end font-medium">Amount</th>
              <th className="py-1.5 text-end font-medium">Txns</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.key} className="border-t border-border/60">
                <td className="max-w-0 truncate py-1.5 pe-2">{monthLabelIfMonth(result.groupBy, r.label)}</td>
                <td className="py-1.5 pe-2 text-end tabular-nums">{formatMoney(r.valueCents / 100)}</td>
                <td className="py-1.5 text-end tabular-nums text-muted-foreground">{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const rows = result.rows as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pe-2 text-start font-medium">Date</th>
            <th className="py-1.5 pe-2 text-start font-medium">Name</th>
            <th className="py-1.5 pe-2 text-start font-medium">Category</th>
            <th className="py-1.5 text-end font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id)} className="border-t border-border/60">
              <td className="whitespace-nowrap py-1.5 pe-2">{formatDate(String(r.date ?? ""))}</td>
              <td className="max-w-0 truncate py-1.5 pe-2">
                {String(r.merchantName ?? r.name ?? "Unknown")}
              </td>
              <td className="max-w-0 truncate py-1.5 pe-2 text-muted-foreground">
                {String(r.category ?? "—")}
              </td>
              <td className="py-1.5 text-end tabular-nums">
                {formatMoney(Number(r.amountCents ?? 0) / 100)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricBody({
  result,
  compare,
  config,
}: {
  result: QueryResult;
  compare: QueryResult | undefined;
  config: SavedViewConfig;
}) {
  const totalCents = sumCents(result);
  const format = config.metric?.format ?? "currency";
  const display =
    format === "number"
      ? totalCents.toLocaleString()
      : formatMoney(totalCents / 100);

  let compareEl: ReactNode = null;
  if (config.metric?.compareMonth && compare) {
    const prevCents = sumCents(compare);
    if (prevCents !== 0) {
      const pct = ((totalCents - prevCents) / Math.abs(prevCents)) * 100;
      const up = pct >= 0;
      compareEl = (
        <p className={up ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>
          {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% vs last month (
          {formatMoney(prevCents / 100)})
        </p>
      );
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 py-4">
      <span className="text-4xl font-semibold tracking-tight tabular-nums">{display}</span>
      {compareEl}
    </div>
  );
}

export function SavedViewCard({
  view,
  showPinToggle = false,
}: {
  view: SavedViewRow;
  showPinToggle?: boolean;
}) {
  const config = view.config;
  const pinMutation = useActionMutation("pin-saved-view");

  function togglePin() {
    pinMutation.mutate(
      { id: view.id, pinned: !view.isPinned },
      {
        onSuccess: () => {
          toast.success(view.isPinned ? `Unpinned "${view.name}"` : `Pinned "${view.name}"`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not update pin.");
        },
      },
    );
  }
  const queryJson = useMemo(
    () => (config ? JSON.stringify(config.query) : null),
    [config],
  );
  const resultQuery = useActionQuery<QueryResult>(
    "run-finance-query",
    { query: queryJson ?? "" },
    { enabled: Boolean(queryJson) },
  );

  const compareQueryObj = useMemo(() => {
    if (view.kind !== "metric" || !config?.metric?.compareMonth || !config) return null;
    return previousMonthQuery(config.query);
  }, [view.kind, config]);
  const compareQuery = useActionQuery<QueryResult>(
    "run-finance-query",
    { query: compareQueryObj ? JSON.stringify(compareQueryObj) : "" },
    { enabled: Boolean(compareQueryObj) },
  );

  return (
    <Card className={cn("flex flex-col rounded-2xl shadow-sm", showPinToggle ? "" : "h-full")}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{view.name}</CardTitle>
          {showPinToggle ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              disabled={pinMutation.isPending}
              onClick={togglePin}
              aria-label={view.isPinned ? "Unpin view" : "Pin view"}
              title={view.isPinned ? "Unpin view" : "Pin view"}
            >
              {view.isPinned ? <IconPinnedOff className="size-4" /> : <IconPin className="size-4" />}
            </Button>
          ) : view.isPinned ? (
            <IconPin className="size-4 shrink-0 text-muted-foreground" aria-label="Pinned" />
          ) : null}
        </div>
        {view.description ? <CardDescription>{view.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex-1">
        {!config ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Invalid view configuration.
          </p>
        ) : resultQuery.isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : resultQuery.isError ? (
          <p className="py-10 text-center text-sm text-destructive">
            {resultQuery.error instanceof Error
              ? resultQuery.error.message
              : "Failed to run query."}
          </p>
        ) : view.kind === "table" ? (
          <TableBody result={resultQuery.data!} />
        ) : view.kind === "metric" ? (
          <MetricBody result={resultQuery.data!} compare={compareQuery.data} config={config} />
        ) : (
          <ChartBody result={resultQuery.data!} config={config} />
        )}
      </CardContent>
    </Card>
  );
}
