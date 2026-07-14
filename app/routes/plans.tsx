/**
 * /plans — Payment Plans: fixed credit-card/loan payoff plans negotiated
 * with a creditor (fixed payment, fixed lower APR, fixed term, due a specific
 * day-of-month, paid FROM a specific checking account). Treated as CRITICAL
 * never-miss bills. Cards show countdown, APR/term progress, a declining-
 * balance mini chart, and a funding status against the pay-from account.
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconCalendarStats,
  IconCheck,
  IconChevronDown,
  IconEdit,
  IconPlus,
  IconReceipt2,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { APP_TITLE } from "@/lib/app-config";
import { formatDate, formatMoney } from "@/lib/finance-format";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Payment Plans - ${APP_TITLE}` }];
}

interface ProjectionContribution {
  date: string;
  name: string;
  amountCents: number;
  kind: "bill" | "subscription" | "income" | "plan";
}

interface ProjectionBasis {
  incomeItems: number;
  billItems: number;
}

interface FundingInfo {
  /** Back-compat alias for projectedFunded. */
  funded: boolean;
  snapshotFundedNow: boolean;
  projectedBalanceAtDueCents: number;
  projectedFunded: boolean;
  shortfallCents: number;
  payFromAccountName: string | null;
  contributions: ProjectionContribution[];
  projectionBasis: ProjectionBasis;
  hasLinkedIncome: boolean;
  fundingStatus: "at_risk" | "unverified" | "ok";
  householdCovered: boolean;
  householdProjectedCents: number;
}

interface PlanRow {
  id: string;
  name: string;
  cardAccountId: string | null;
  payFromAccountId: string | null;
  payFromAccountName: string | null;
  paymentCents: number;
  payment: number;
  dueDay: number;
  aprBps: number | null;
  apr: number | null;
  termMonths: number | null;
  startDate: string | null;
  originalBalanceCents: number | null;
  currentBalanceCents: number | null;
  currentBalance: number;
  merchantKey: string | null;
  status: "active" | "paid_off" | "closed";
  notes: string | null;
  nextDueDate: string;
  daysUntil: number;
  critical: true;
  /** NET severity: red only when at_risk AND the household can't cover it. */
  warn: boolean;
  householdCovered: boolean;
  householdProjectedCents: number;
  paidThisMonth: boolean;
  remainingPayments: number | null;
  paymentsMade: number | null;
  projectedPayoffDate: string | null;
  funding: FundingInfo;
}

interface ListPaymentPlansResult {
  plans: PlanRow[];
}

interface AmortizationRow {
  date: string;
  balance: number;
}
interface GetPaymentPlanResult {
  amortization: { rows: AmortizationRow[]; payoffDate: string | null };
}

interface AccountOption {
  id: string;
  name: string | null;
  type: string | null;
  mask: string | null;
}
interface ListAccountsResult {
  id: string;
  name: string;
  accounts: AccountOption[];
}

function relativeDue(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function countdownVariant(days: number): "destructive" | "warning" | "default" {
  if (days <= 3) return "destructive";
  if (days <= 7) return "warning";
  return "default";
}

interface PlanFormState {
  name: string;
  cardAccountId: string;
  payFromAccountId: string;
  paymentDollars: string;
  dueDay: string;
  aprPct: string;
  termMonths: string;
  startingBalanceDollars: string;
  merchantKey: string;
  notes: string;
}

const EMPTY_FORM: PlanFormState = {
  name: "",
  cardAccountId: "none",
  payFromAccountId: "",
  paymentDollars: "",
  dueDay: "1",
  aprPct: "",
  termMonths: "",
  startingBalanceDollars: "",
  merchantKey: "",
  notes: "",
};

const NUDGE_DISMISS_KEY = "finance:plans-income-link-nudge-dismissed";

function PlanBalanceChart({ planId }: { planId: string }) {
  const detailQuery = useActionQuery<GetPaymentPlanResult>("get-payment-plan", { id: planId });
  const chartData = useMemo(
    () => (detailQuery.data?.amortization.rows ?? []).map((r) => ({ date: r.date, balance: r.balance })),
    [detailQuery.data],
  );
  if (detailQuery.isLoading) return <Skeleton className="h-16 w-full" />;
  if (chartData.length === 0) return null;
  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
          <defs>
            <linearGradient id={`planBalance-${planId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="balance"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            fill={`url(#planBalance-${planId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Expandable "what's counted in this projection" list — dated income/bill/plan contributions. */
function ContributionsDisclosure({ plan }: { plan: PlanRow }) {
  const [open, setOpen] = useState(false);
  const { contributions } = plan.funding;

  // A compact "what's counted" summary that renders even with no dated
  // contributions: whether income is linked, whether the household covers it,
  // and how many contributions were folded in.
  const summary = (
    <p className="pl-6 text-[11px] text-muted-foreground">
      Income linked: {plan.funding.hasLinkedIncome ? "yes" : "no"} · Household coverage:{" "}
      {plan.funding.householdCovered
        ? `yes (${formatMoney(plan.funding.householdProjectedCents / 100)} across accounts)`
        : "no"}
    </p>
  );

  if (contributions.length === 0) {
    return (
      <div className="space-y-1">
        <p className="pl-6 text-xs text-muted-foreground">
          No projected activity between today and {formatDate(plan.nextDueDate)} in this account.
        </p>
        {summary}
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 pl-6 text-xs font-medium underline-offset-2 hover:underline"
        >
          <IconChevronDown className={cn("size-3 transition-transform", open ? "rotate-180" : undefined)} />
          What's counted ({contributions.length})
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 space-y-1 pl-6">
        {summary}
        {contributions.map((c, i) => (
          <div key={`${c.date}-${c.name}-${i}`} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              {formatDate(c.date)} · {c.name}
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                c.kind === "income" ? "text-fin-positive" : "text-foreground",
              )}
            >
              {c.kind === "income" ? "+" : "-"}
              {formatMoney(Math.abs(c.amountCents) / 100)}
            </span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PlanCard({
  plan,
  onEdit,
  onDelete,
  onMatch,
  matching,
}: {
  plan: PlanRow;
  onEdit: () => void;
  onDelete: () => void;
  onMatch: () => void;
  matching: boolean;
}) {
  const variant = countdownVariant(plan.daysUntil);
  const paymentNumber =
    plan.paymentsMade != null && plan.termMonths ? Math.min(plan.termMonths, plan.paymentsMade + 1) : null;

  // Three-tier severity:
  //  - red    = plan.warn (at_risk AND household can't cover) — real alarm.
  //  - amber  = householdCovered ("move funds") OR unverified ("link income").
  //  - calm   = ok, or reassuring (snapshot short but projected funded).
  const isReassuring = !plan.funding.snapshotFundedNow && plan.funding.projectedFunded;
  const isHouseholdCovered = !plan.warn && plan.funding.householdCovered;
  const isUnverified =
    !plan.warn && !isHouseholdCovered && plan.funding.fundingStatus === "unverified";
  const isAmber = isHouseholdCovered || isUnverified;

  return (
    <Card
      className={cn(
        "rounded-2xl shadow-sm border-l-4",
        plan.warn
          ? "border-destructive/50"
          : isAmber
            ? "border-l-fin-warning/60"
            : "border-l-primary/40",
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {plan.name}
              <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wide text-muted-foreground border-border">
                <IconShieldCheck className="size-3" />
                Plan
              </Badge>
            </CardTitle>
            <CardDescription>
              <span className="font-semibold text-foreground">{formatMoney(plan.payment)}</span> on the {plan.dueDay}
              {plan.dueDay === 1 ? "st" : plan.dueDay === 2 ? "nd" : plan.dueDay === 3 ? "rd" : "th"}
            </CardDescription>
          </div>
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0 text-xs",
              plan.warn && variant === "destructive"
                ? "bg-destructive/15 text-destructive"
                : plan.warn && variant === "warning"
                  ? "bg-fin-warning/15 text-fin-warning"
                  : "bg-secondary text-secondary-foreground",
            )}
          >
            {relativeDue(plan.daysUntil)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Balance remaining</span>
          <span className="font-semibold tabular-nums">{formatMoney(plan.currentBalance)}</span>
        </div>
        <PlanBalanceChart planId={plan.id} />

        {plan.termMonths ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {paymentNumber != null ? `Payment ${paymentNumber} of ${plan.termMonths}` : `${plan.termMonths}-month term`}
              </span>
              {plan.apr != null ? <span>{plan.apr.toFixed(2)}% APR</span> : null}
            </div>
            {paymentNumber != null ? (
              <Progress value={Math.min(100, (paymentNumber / plan.termMonths) * 100)} className="h-1.5" />
            ) : null}
          </div>
        ) : null}

        {plan.warn ? (
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <IconAlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                Projected short {formatMoney(plan.funding.shortfallCents / 100)} — projected balance{" "}
                {formatMoney(plan.funding.projectedBalanceAtDueCents / 100)} vs. {formatMoney(plan.payment)} needed
                by {formatDate(plan.nextDueDate)}. Your linked income doesn't cover it and there isn't enough
                across your other accounts either.
              </span>
            </div>
            <ContributionsDisclosure plan={plan} />
          </div>
        ) : isHouseholdCovered ? (
          <div className="space-y-1.5 rounded-lg border border-fin-warning/30 bg-fin-warning/10 p-2.5 text-sm text-fin-warning">
            <div className="flex items-center gap-2">
              <IconAlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                Funds available across your accounts — move {formatMoney(plan.payment)} to{" "}
                {plan.funding.payFromAccountName ?? "the pay-from account"} by {formatDate(plan.nextDueDate)}.
                The pay-from account alone is projected at{" "}
                {formatMoney(plan.funding.projectedBalanceAtDueCents / 100)}.
              </span>
            </div>
            <ContributionsDisclosure plan={plan} />
          </div>
        ) : isUnverified ? (
          <div className="space-y-1.5 rounded-lg border border-fin-warning/30 bg-fin-warning/10 p-2.5 text-sm text-fin-warning">
            <div className="flex items-center gap-2">
              <IconAlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                Can't verify funding — no income is linked to{" "}
                {plan.funding.payFromAccountName ?? "the pay-from account"}, so this projection assumes none
                arrives.{" "}
                <Link to="/recurring" className="font-medium underline underline-offset-2">
                  Link your paycheck's deposit account
                </Link>{" "}
                for accurate projections.
              </span>
            </div>
            <ContributionsDisclosure plan={plan} />
          </div>
        ) : isReassuring ? (
          <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2.5 text-sm text-muted-foreground">
            <p>
              Currently {formatMoney(plan.currentBalance)} in {plan.funding.payFromAccountName ?? "the pay-from account"}{" "}
              — projected {formatMoney(plan.funding.projectedBalanceAtDueCents / 100)} by{" "}
              {formatDate(plan.nextDueDate)} after expected income.
            </p>
            <ContributionsDisclosure plan={plan} />
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-fin-positive/30 bg-fin-positive/10 p-2.5 text-sm text-fin-positive">
            <IconCheck className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              Funded — enough in {plan.funding.payFromAccountName ?? "the pay-from account"}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Pays from {plan.payFromAccountName ?? "—"}</span>
          <span className="flex items-center gap-1">
            {plan.paidThisMonth ? (
              <>
                <IconCheck className="size-3.5 text-fin-positive" /> Paid this month
              </>
            ) : (
              "Not yet paid this month"
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onMatch} disabled={matching}>
              <IconRefresh className={matching ? "size-4 animate-spin" : "size-4"} />
              Match payments
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link
                to={`/spending?merchant=${encodeURIComponent(plan.merchantKey || plan.name)}&table=transactions`}
              >
                <IconReceipt2 className="size-4" />
                Payments
              </Link>
            </Button>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className="size-8" onClick={onEdit} aria-label="Edit">
              <IconEdit className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              aria-label="Delete"
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PlansRoute() {
  useSetPageTitle("Payment Plans");

  const listQuery = useActionQuery<ListPaymentPlansResult>("list-payment-plans", { status: "active" });
  const accountsQuery = useActionQuery<ListAccountsResult[]>("list-accounts", {});
  const recurringQuery = useActionQuery<{ income: Array<{ isActive: boolean; accountId: string | null }> }>(
    "list-recurring",
    {},
  );
  const createMutation = useActionMutation("create-payment-plan");
  const updateMutation = useActionMutation("update-payment-plan");
  const deleteMutation = useActionMutation("delete-payment-plan");
  const matchMutation = useActionMutation("match-plan-payments");

  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<PlanRow | null>(null);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(NUDGE_DISMISS_KEY) === "1",
  );

  const plans = listQuery.data?.plans ?? [];

  const creditAccounts = useMemo(
    () =>
      (accountsQuery.data ?? []).flatMap((inst) =>
        inst.accounts
          .filter((a) => a.type === "credit" || a.type === "loan")
          .map((a) => ({ id: a.id, label: `${inst.name} · ${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}` })),
      ),
    [accountsQuery.data],
  );
  const depositoryAccounts = useMemo(
    () =>
      (accountsQuery.data ?? []).flatMap((inst) =>
        inst.accounts
          .filter((a) => a.type === "depository" || a.type == null)
          .map((a) => ({ id: a.id, label: `${inst.name} · ${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}` })),
      ),
    [accountsQuery.data],
  );

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreating(true);
  }

  function openEdit(plan: PlanRow) {
    setForm({
      name: plan.name,
      cardAccountId: plan.cardAccountId ?? "none",
      payFromAccountId: plan.payFromAccountId ?? "",
      paymentDollars: String(plan.payment),
      dueDay: String(plan.dueDay),
      aprPct: plan.apr != null ? String(plan.apr) : "",
      termMonths: plan.termMonths != null ? String(plan.termMonths) : "",
      startingBalanceDollars: plan.originalBalanceCents != null ? String(plan.originalBalanceCents / 100) : "",
      merchantKey: plan.merchantKey ?? "",
      notes: plan.notes ?? "",
    });
    setEditing(plan);
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  function submitForm() {
    const paymentDollars = Number(form.paymentDollars);
    const dueDay = Number(form.dueDay);
    if (!form.name.trim() || Number.isNaN(paymentDollars) || paymentDollars <= 0) {
      toast.error("Name and a positive payment amount are required.");
      return;
    }
    if (!editing && !form.payFromAccountId) {
      toast.error("Pick a pay-from account.");
      return;
    }
    if (Number.isNaN(dueDay) || dueDay < 1 || dueDay > 31) {
      toast.error("Due day must be between 1 and 31.");
      return;
    }

    const aprBps = form.aprPct.trim() ? Math.round(Number(form.aprPct) * 100) : undefined;
    const termMonths = form.termMonths.trim() ? Math.round(Number(form.termMonths)) : undefined;
    const originalBalanceCents = form.startingBalanceDollars.trim()
      ? Math.round(Number(form.startingBalanceDollars) * 100)
      : undefined;

    const basePayload = {
      name: form.name.trim(),
      cardAccountId: form.cardAccountId === "none" ? null : form.cardAccountId,
      paymentCents: Math.round(paymentDollars * 100),
      dueDay,
      aprBps,
      termMonths,
      merchantKey: form.merchantKey.trim() || undefined,
      notes: form.notes.trim() || undefined,
    };

    if (editing) {
      updateMutation.mutate(
        {
          id: editing.id,
          ...basePayload,
          payFromAccountId: form.payFromAccountId || undefined,
          originalBalanceCents,
        },
        {
          onSuccess: () => {
            toast.success(`Updated "${form.name.trim()}"`);
            closeForm();
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
        },
      );
    } else {
      createMutation.mutate(
        {
          ...basePayload,
          payFromAccountId: form.payFromAccountId,
          originalBalanceCents,
          currentBalanceCents: originalBalanceCents,
        },
        {
          onSuccess: () => {
            toast.success(`Created "${form.name.trim()}"`);
            closeForm();
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create"),
        },
      );
    }
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          toast.success(`Deleted "${deleteTarget.name}"`);
          setDeleteTarget(null);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete"),
      },
    );
  }

  function matchPayments(plan: PlanRow) {
    setMatchingId(plan.id);
    matchMutation.mutate(
      { planId: plan.id },
      {
        onSuccess: (result: { totalMatched: number }) => {
          toast.success(
            result.totalMatched > 0
              ? `Matched ${result.totalMatched} payment${result.totalMatched === 1 ? "" : "s"}`
              : "No new matching payments found",
          );
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Match failed"),
        onSettled: () => setMatchingId(null),
      },
    );
  }

  const isLoading = listQuery.isLoading;
  const needsAttention = plans.filter((p) => p.warn);

  // One-time nudge: active plans exist but no active income recurring has a
  // deposit account linked, so projections assume no income arrives.
  const hasLinkedIncomeAccount = (recurringQuery.data?.income ?? []).some(
    (r) => r.isActive && r.accountId,
  );
  const showIncomeLinkNudge =
    !nudgeDismissed &&
    !isLoading &&
    plans.length > 0 &&
    !hasLinkedIncomeAccount &&
    !recurringQuery.isLoading;

  function dismissNudge() {
    setNudgeDismissed(true);
    if (typeof window !== "undefined") window.localStorage.setItem(NUDGE_DISMISS_KEY, "1");
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Payment Plans</h1>
          <p className="text-sm text-muted-foreground">
            Fixed credit-card payoff plans. These are critical — missing a payment is not an option.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <IconPlus className="size-4" />
          Add plan
        </Button>
      </div>

      {showIncomeLinkNudge ? (
        <Card className="rounded-2xl border-fin-warning/40 bg-fin-warning/5 shadow-sm">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <IconShieldCheck className="size-5 shrink-0 text-fin-warning" />
            <p className="min-w-0 flex-1 text-sm text-foreground">
              Link your paycheck's deposit account so plan projections know money is arriving — otherwise a
              plan can look at risk purely because no income is linked to its pay-from account.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button asChild size="sm" variant="secondary">
                <Link to="/recurring">Link income account</Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={dismissNudge}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!isLoading && needsAttention.length > 0 ? (
        <Card className="rounded-2xl border-destructive/40 bg-destructive/5 shadow-sm">
          <CardContent className="flex items-start gap-3 py-4">
            <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-destructive">
                {needsAttention.length} plan{needsAttention.length === 1 ? "" : "s"} need
                {needsAttention.length === 1 ? "s" : ""} attention
              </p>
              <p className="text-muted-foreground">
                Projected balance at the due date falls short of the payment — check the details on each card
                below.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-72 w-full rounded-2xl" />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="py-16 text-center">
            <IconCalendarStats className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No payment plans yet. Add one for a negotiated fixed payment, fixed rate, and fixed term.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onEdit={() => openEdit(plan)}
              onDelete={() => setDeleteTarget(plan)}
              onMatch={() => matchPayments(plan)}
              matching={matchingId === plan.id}
            />
          ))}
        </div>
      )}

      <Dialog open={creating || editing !== null} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit payment plan" : "Add payment plan"}</DialogTitle>
            <DialogDescription>
              A fixed payment plan negotiated with a creditor — payment, rate, and term are fixed but can be
              edited later if terms change.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="plan-name">Name</Label>
              <Input
                id="plan-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Example Card Visa settlement plan"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label>Card / loan account</Label>
                <Select
                  value={form.cardAccountId}
                  onValueChange={(v) => setForm((f) => ({ ...f, cardAccountId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not linked</SelectItem>
                    {creditAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Pay-from account</Label>
                <Select
                  value={form.payFromAccountId}
                  onValueChange={(v) => setForm((f) => ({ ...f, payFromAccountId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose account" />
                  </SelectTrigger>
                  <SelectContent>
                    {depositoryAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="plan-payment">Payment ($)</Label>
                <Input
                  id="plan-payment"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.paymentDollars}
                  onChange={(e) => setForm((f) => ({ ...f, paymentDollars: e.target.value }))}
                  placeholder="470.00"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="plan-due-day">Due day of month</Label>
                <Input
                  id="plan-due-day"
                  type="number"
                  min="1"
                  max="31"
                  value={form.dueDay}
                  onChange={(e) => setForm((f) => ({ ...f, dueDay: e.target.value }))}
                  placeholder="17"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="plan-apr">APR (%)</Label>
                <Input
                  id="plan-apr"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.aprPct}
                  onChange={(e) => setForm((f) => ({ ...f, aprPct: e.target.value }))}
                  placeholder="7.25"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="plan-term">Term (months)</Label>
                <Input
                  id="plan-term"
                  type="number"
                  min="1"
                  value={form.termMonths}
                  onChange={(e) => setForm((f) => ({ ...f, termMonths: e.target.value }))}
                  placeholder="60"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-balance">Starting balance ($)</Label>
              <Input
                id="plan-balance"
                type="number"
                step="0.01"
                min="0"
                value={form.startingBalanceDollars}
                onChange={(e) => setForm((f) => ({ ...f, startingBalanceDollars: e.target.value }))}
                placeholder="22000.00"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-merchant">Merchant match text (optional)</Label>
              <Input
                id="plan-merchant"
                value={form.merchantKey}
                onChange={(e) => setForm((f) => ({ ...f, merchantKey: e.target.value }))}
                placeholder="e.g. example card services"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-notes">Notes</Label>
              <Textarea
                id="plan-notes"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeForm}>
              Cancel
            </Button>
            <Button onClick={submitForm} disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? "Save changes" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconAlertTriangle className="size-5 text-destructive" />
              Delete "{deleteTarget?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the payment plan. Matched transactions keep their history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
