/**
 * /recurring — manage recurring bills, subscriptions, and income. Sections
 * for each kind, an edit dialog, delete confirm, and an agent-parity "Scan
 * for recurring" flow (detect-recurring -> candidate cards -> create-recurring).
 */
import { callAction, useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBolt,
  IconCalendarEvent,
  IconCheck,
  IconDotsVertical,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRepeat,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { APP_TITLE } from "@/lib/app-config";
import { formatDate, formatMoney } from "@/lib/finance-format";

export function meta() {
  return [{ title: `Recurring - ${APP_TITLE}` }];
}

type RecurringKind = "bill" | "subscription" | "income";
type RecurringFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
type Confidence = "high" | "medium" | "low";

interface RecurringItem {
  id: string;
  name: string;
  merchantKey: string | null;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  anchorDate: string | null;
  avgAmountCents: number | null;
  avgAmount: number;
  lastAmountCents: number | null;
  lastSeenDate: string | null;
  accountId: string | null;
  categoryId: string | null;
  category: string | null;
  isActive: boolean;
  autoDetected: boolean;
  notes: string | null;
  nextDueDate: string | null;
  monthlyizedAmountCents: number;
  monthlyizedAmount: number;
}

interface ListRecurringResult {
  bills: RecurringItem[];
  subscriptions: RecurringItem[];
  income: RecurringItem[];
  all: RecurringItem[];
  monthlyPlansCents?: number;
}

/** Subset of list-payment-plans rows used by the plans section here. */
interface PlanListRow {
  id: string;
  name: string;
  paymentCents: number;
  dueDay: number;
  nextDueDate: string;
  daysUntil: number;
  /** NET severity: red only when at_risk AND household can't cover. */
  warn: boolean;
  householdCovered: boolean;
  funding: {
    snapshotFundedNow: boolean;
    projectedFunded: boolean;
    payFromAccountName: string | null;
    fundingStatus: "at_risk" | "unverified" | "ok";
    hasLinkedIncome: boolean;
  };
  aprBps: number | null;
  remainingPayments: number | null;
}
interface PlanListResult {
  plans: PlanListRow[];
}

interface RecurringCandidate {
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

interface DetectRecurringResult {
  candidates: RecurringCandidate[];
  scannedCount: number;
  excludedExistingMerchantKeys: number;
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

const FREQUENCY_LABEL: Record<RecurringFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "bg-fin-positive/15 text-fin-positive",
  medium: "bg-fin-warning/15 text-fin-warning",
  low: "bg-muted text-muted-foreground",
};

function relativeDue(nextDueDate: string | null): string {
  if (!nextDueDate) return "—";
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round(
    (new Date(`${nextDueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
      86_400_000,
  );
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

interface RecurringFormState {
  name: string;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  anchorDate: string;
  avgAmountDollars: string;
  categoryId: string;
  accountId: string;
  notes: string;
}

const EMPTY_FORM: RecurringFormState = {
  name: "",
  kind: "bill",
  frequency: "monthly",
  anchorDate: new Date().toISOString().slice(0, 10),
  avgAmountDollars: "",
  categoryId: "none",
  accountId: "none",
  notes: "",
};

const NUDGE_DISMISS_KEY = "finance:recurring-income-link-nudge-dismissed";

function RecurringRow({
  item,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  item: RecurringItem;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: (next: boolean) => void;
}) {
  const isIncome = item.kind === "income";
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-0 py-2.5 transition-colors hover:bg-accent/50 sm:items-center sm:gap-3 sm:px-2">
      <div
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full sm:mt-0 sm:size-9",
          isIncome
            ? "bg-fin-positive/15 text-fin-positive"
            : "bg-secondary text-secondary-foreground",
        )}
      >
        {item.kind === "subscription" ? (
          <IconRepeat className="size-4" />
        ) : isIncome ? (
          <IconArrowUpRight className="size-4" />
        ) : (
          <IconBolt className="size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{item.name}</p>
          {item.autoDetected ? (
            <Badge variant="outline" className="hidden shrink-0 gap-1 text-[10px] sm:inline-flex">
              <IconSparkles className="size-3" /> auto
            </Badge>
          ) : null}
          {!item.isActive ? (
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              paused
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {FREQUENCY_LABEL[item.frequency]} · next due {relativeDue(item.nextDueDate)}
          {item.category ? ` · ${item.category}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-end">
        <p
          className={
            isIncome
              ? "text-sm font-semibold tabular-nums text-fin-positive"
              : "text-sm font-semibold tabular-nums"
          }
        >
          {formatMoney(Math.abs(item.avgAmount))}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatMoney(Math.abs(item.monthlyizedAmount))}/mo
        </p>
      </div>
      {/* Desktop: inline toggle + edit + delete. */}
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        <Switch
          checked={item.isActive}
          onCheckedChange={onToggleActive}
          aria-label={item.isActive ? "Deactivate" : "Activate"}
          className="me-1 shrink-0"
        />
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onEdit} aria-label="Edit">
          <IconEdit className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label="Delete"
        >
          <IconTrash className="size-4" />
        </Button>
      </div>
      {/* Mobile: actions collapse into one menu so the name keeps its room. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground sm:hidden"
            aria-label={`Actions for ${item.name}`}
          >
            <IconDotsVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onToggleActive(!item.isActive)}>
            {item.isActive ? (
              <>
                <IconPlayerPause className="size-4" /> Pause
              </>
            ) : (
              <>
                <IconPlayerPlay className="size-4" /> Resume
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onEdit}>
            <IconEdit className="size-4" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
            onSelect={onDelete}
          >
            <IconTrash className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RecurringSection({
  title,
  description,
  items,
  totalLabel,
  totalCents,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  title: string;
  description: string;
  items: RecurringItem[];
  totalLabel: string;
  totalCents: number;
  onEdit: (item: RecurringItem) => void;
  onDelete: (item: RecurringItem) => void;
  onToggleActive: (item: RecurringItem, next: boolean) => void;
}) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="text-end">
          <p className="text-xs text-muted-foreground">{totalLabel}</p>
          <p className="text-sm font-semibold tabular-nums">{formatMoney(Math.abs(totalCents) / 100)}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing here yet.</p>
        ) : (
          items.map((item) => (
            <RecurringRow
              key={item.id}
              item={item}
              onEdit={() => onEdit(item)}
              onDelete={() => onDelete(item)}
              onToggleActive={(next) => onToggleActive(item, next)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default function RecurringRoute() {
  useSetPageTitle("Recurring");

  const listQuery = useActionQuery<ListRecurringResult>("list-recurring", {});
  const plansQuery = useActionQuery<PlanListResult>("list-payment-plans", {});
  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {});
  const accountsQuery = useActionQuery<ListAccountsResult[]>("list-accounts", {});
  const createMutation = useActionMutation("create-recurring");
  const updateMutation = useActionMutation("update-recurring");
  const deleteMutation = useActionMutation("delete-recurring");

  const [editing, setEditing] = useState<RecurringItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<RecurringFormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<RecurringItem | null>(null);

  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<RecurringCandidate[] | null>(null);
  const [scanMeta, setScanMeta] = useState<{ scannedCount: number } | null>(null);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [nudgeDismissed, setNudgeDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(NUDGE_DISMISS_KEY) === "1",
  );

  const bills = listQuery.data?.bills ?? [];
  const subscriptions = listQuery.data?.subscriptions ?? [];
  const income = listQuery.data?.income ?? [];
  const plans = plansQuery.data?.plans ?? [];
  const monthlyPlansTotal = plans.reduce((s, p) => s + p.paymentCents, 0);

  const depositoryAccounts = useMemo(
    () =>
      (accountsQuery.data ?? []).flatMap((inst) =>
        inst.accounts
          .filter((a) => a.type === "depository" || a.type == null)
          .map((a) => ({ id: a.id, label: `${inst.name} · ${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}` })),
      ),
    [accountsQuery.data],
  );

  const monthlyBillsTotal = useMemo(
    () =>
      [...bills, ...subscriptions]
        .filter((r) => r.isActive)
        .reduce((sum, r) => sum + r.monthlyizedAmountCents, 0),
    [bills, subscriptions],
  );
  const monthlyIncomeTotal = useMemo(
    () => income.filter((r) => r.isActive).reduce((sum, r) => sum + Math.abs(r.monthlyizedAmountCents), 0),
    [income],
  );

  // Show a one-time nudge when there are active plans but NO income recurring
  // has a deposit account linked — that's exactly the state that makes plan
  // funding projections pessimistic (they assume no income arrives).
  const hasLinkedIncomeAccount = income.some((r) => r.isActive && r.accountId);
  const showIncomeLinkNudge =
    !nudgeDismissed && plans.length > 0 && !hasLinkedIncomeAccount && !listQuery.isLoading;

  function dismissNudge() {
    setNudgeDismissed(true);
    if (typeof window !== "undefined") window.localStorage.setItem(NUDGE_DISMISS_KEY, "1");
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreating(true);
  }

  /** Open the create dialog pre-set to an income recurring so the user can link a deposit account. */
  function openLinkIncome() {
    const firstIncome = income[0];
    if (firstIncome) {
      openEdit(firstIncome);
      return;
    }
    setForm({ ...EMPTY_FORM, kind: "income" });
    setCreating(true);
  }

  function openEdit(item: RecurringItem) {
    setForm({
      name: item.name,
      kind: item.kind,
      frequency: item.frequency,
      anchorDate: item.anchorDate ?? new Date().toISOString().slice(0, 10),
      avgAmountDollars: String(Math.abs((item.avgAmountCents ?? 0) / 100)),
      categoryId: item.categoryId ?? "none",
      accountId: item.accountId ?? "none",
      notes: item.notes ?? "",
    });
    setEditing(item);
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  function submitForm() {
    const dollars = Number(form.avgAmountDollars);
    if (!form.name.trim() || Number.isNaN(dollars)) {
      toast.error("Name and amount are required.");
      return;
    }
    const signedCents =
      form.kind === "income" ? -Math.round(Math.abs(dollars) * 100) : Math.round(Math.abs(dollars) * 100);
    const payload = {
      name: form.name.trim(),
      kind: form.kind,
      frequency: form.frequency,
      anchorDate: form.anchorDate,
      avgAmountCents: signedCents,
      categoryId: form.categoryId === "none" ? undefined : form.categoryId,
      accountId: form.accountId === "none" ? undefined : form.accountId,
      notes: form.notes.trim() || undefined,
    };

    if (editing) {
      updateMutation.mutate(
        {
          id: editing.id,
          ...payload,
          categoryId: form.categoryId === "none" ? null : form.categoryId,
          accountId: form.accountId === "none" ? null : form.accountId,
        },
        {
          onSuccess: () => {
            toast.success(`Updated "${payload.name}"`);
            closeForm();
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
        },
      );
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => {
          toast.success(`Created "${payload.name}"`);
          closeForm();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create"),
      });
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

  function toggleActive(item: RecurringItem, next: boolean) {
    updateMutation.mutate(
      { id: item.id, isActive: next },
      {
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
      },
    );
  }

  async function runScan() {
    setScanning(true);
    setCandidates(null);
    try {
      const data = await callAction<DetectRecurringResult>(
        "detect-recurring",
        {},
        { method: "GET" },
      );
      setCandidates(data.candidates);
      setScanMeta({ scannedCount: data.scannedCount });
      if (data.candidates.length === 0) {
        toast.info("No recurring patterns found. Try again after more transactions sync.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  function addCandidate(candidate: RecurringCandidate) {
    createMutation.mutate(
      {
        name: candidate.suggestedName,
        kind: candidate.kind,
        frequency: candidate.frequency,
        anchorDate: candidate.lastDate,
        avgAmountCents: candidate.avgAmountCents,
        merchantKey: candidate.merchantKey,
        autoDetected: true,
      },
      {
        onSuccess: () => {
          setAddedKeys((prev) => new Set(prev).add(candidate.merchantKey));
          toast.success(`Added "${candidate.suggestedName}"`);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add"),
      },
    );
  }

  function addAllHighConfidence() {
    const highConfidence = (candidates ?? []).filter(
      (c) => c.confidence === "high" && !addedKeys.has(c.merchantKey),
    );
    for (const c of highConfidence) addCandidate(c);
  }

  const isLoading = listQuery.isLoading;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Recurring</h1>
          <p className="text-sm text-muted-foreground">
            Bills, subscriptions, and income the agent (or you) can track and project.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={runScan} disabled={scanning}>
            <IconSearch className={scanning ? "size-4 animate-pulse" : "size-4"} />
            {scanning ? "Scanning..." : "Scan for recurring"}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <IconPlus className="size-4" />
            Add recurring
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Monthly bills & subscriptions</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatMoney(monthlyBillsTotal / 100)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-2xl shadow-sm border-l-4 border-l-primary/60">
          <CardHeader className="pb-2">
            <CardDescription>Monthly payment plans</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatMoney(monthlyPlansTotal / 100)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Monthly income</CardDescription>
            <CardTitle className="text-2xl tabular-nums text-fin-positive">
              {formatMoney(monthlyIncomeTotal / 100)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {showIncomeLinkNudge ? (
        <Card className="rounded-2xl border-fin-warning/40 bg-fin-warning/5 shadow-sm">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <IconArrowUpRight className="size-5 shrink-0 text-fin-warning" />
            <p className="min-w-0 flex-1 text-sm text-foreground">
              Link your paycheck's deposit account so plan projections know money is arriving. Otherwise
              funding checks assume no income lands in that account and may warn unnecessarily.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" onClick={openLinkIncome}>
                Link income account
              </Button>
              <Button size="sm" variant="ghost" onClick={dismissNudge}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {plans.length > 0 ? (
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">Payment plans</CardTitle>
              <CardDescription>
                Loan-like critical bills paid from a specific account. Managed on the Plans page.
              </CardDescription>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to="/plans">Manage plans</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {plans.map((p) => {
              // Amber (informational) = money exists across accounts but not in
              // the pay-from one (householdCovered), or the projection can't be
              // trusted because no income is linked (unverified). Neither is red.
              const isAmber =
                !p.warn && (p.householdCovered || p.funding.fundingStatus === "unverified");
              return (
              <Link
                key={p.id}
                to="/plans"
                className={cn(
                  "flex flex-col gap-1 rounded-lg border border-l-4 px-3 py-2 transition-colors hover:bg-accent/40 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2",
                  p.warn
                    ? "border-l-destructive bg-destructive/5"
                    : isAmber
                      ? "border-l-fin-warning bg-fin-warning/5"
                      : "border-l-primary/60",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px] uppercase">
                    Plan
                  </Badge>
                  {p.warn ? (
                    <Badge variant="destructive" className="shrink-0 text-[10px]">
                      Projected short
                    </Badge>
                  ) : isAmber ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-fin-warning/40 text-[10px] text-fin-warning"
                    >
                      {p.householdCovered ? "Move funds" : "Link income"}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 text-sm sm:justify-normal">
                  {p.funding.payFromAccountName ? (
                    <span className="hidden text-xs text-muted-foreground lg:inline">
                      from {p.funding.payFromAccountName}
                    </span>
                  ) : null}
                  {p.aprBps != null ? (
                    <span className="hidden text-xs text-muted-foreground md:inline">
                      {(p.aprBps / 100).toFixed(2)}%
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    due {p.nextDueDate} ({p.daysUntil}d)
                  </span>
                  <span className="font-medium tabular-nums">{formatMoney(p.paymentCents / 100)}</span>
                </div>
              </Link>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {candidates !== null ? (
        <Card className="rounded-2xl shadow-sm border-primary/30">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <IconWand className="size-4 text-primary" />
                Scan results
              </CardTitle>
              <CardDescription>
                Scanned {scanMeta?.scannedCount ?? 0} transactions · {candidates.length} candidate
                {candidates.length === 1 ? "" : "s"} found.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {candidates.some((c) => c.confidence === "high" && !addedKeys.has(c.merchantKey)) ? (
                <Button size="sm" variant="secondary" onClick={addAllHighConfidence}>
                  <IconCheck className="size-4" />
                  Add all high confidence
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setCandidates(null)}>
                Dismiss
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {candidates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">
                No recurring patterns found yet.
              </p>
            ) : (
              candidates.map((c) => {
                const added = addedKeys.has(c.merchantKey);
                return (
                  <Card key={c.merchantKey} className="border-border/70">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-sm">{c.suggestedName}</CardTitle>
                        <Badge className={CONFIDENCE_STYLE[c.confidence]} variant="secondary">
                          {c.confidence}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">{c.cadenceDescription}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex items-center justify-between pt-0">
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {c.kind}
                      </Badge>
                      <Button
                        size="sm"
                        variant={added ? "ghost" : "default"}
                        disabled={added}
                        onClick={() => addCandidate(c)}
                      >
                        {added ? (
                          <>
                            <IconCheck className="size-4" /> Added
                          </>
                        ) : (
                          "Add"
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <RecurringSection
            title="Bills"
            description="Fixed recurring expenses like rent, utilities, and loans."
            items={bills}
            totalLabel="Monthly total"
            totalCents={bills.filter((r) => r.isActive).reduce((s, r) => s + r.monthlyizedAmountCents, 0)}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onToggleActive={toggleActive}
          />
          <RecurringSection
            title="Subscriptions"
            description="Recurring services and memberships."
            items={subscriptions}
            totalLabel="Monthly total"
            totalCents={subscriptions
              .filter((r) => r.isActive)
              .reduce((s, r) => s + r.monthlyizedAmountCents, 0)}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onToggleActive={toggleActive}
          />
          <RecurringSection
            title="Income"
            description="Recurring paychecks and other regular deposits."
            items={income}
            totalLabel="Monthly total"
            totalCents={income
              .filter((r) => r.isActive)
              .reduce((s, r) => s + Math.abs(r.monthlyizedAmountCents), 0)}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onToggleActive={toggleActive}
          />
        </>
      )}

      <div className="flex justify-center">
        <Button asChild variant="ghost" size="sm">
          <Link to="/runway">
            <IconCalendarEvent className="size-4" />
            View cashflow runway
          </Link>
        </Button>
      </div>

      <Dialog open={creating || editing !== null} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit recurring" : "Add recurring"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this recurring bill, subscription, or income."
                : "Track a bill, subscription, or income that repeats on a schedule."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rec-name">Name</Label>
              <Input
                id="rec-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Netflix, Rent, Paycheck"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label>Kind</Label>
                <Select
                  value={form.kind}
                  onValueChange={(v) => setForm((f) => ({ ...f, kind: v as RecurringKind }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bill">Bill</SelectItem>
                    <SelectItem value="subscription">Subscription</SelectItem>
                    <SelectItem value="income">Income</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Frequency</Label>
                <Select
                  value={form.frequency}
                  onValueChange={(v) => setForm((f) => ({ ...f, frequency: v as RecurringFrequency }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(FREQUENCY_LABEL) as RecurringFrequency[]).map((f) => (
                      <SelectItem key={f} value={f}>
                        {FREQUENCY_LABEL[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="rec-anchor">Anchor date</Label>
                <Input
                  id="rec-anchor"
                  type="date"
                  value={form.anchorDate}
                  onChange={(e) => setForm((f) => ({ ...f, anchorDate: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rec-amount">Amount ($)</Label>
                <Input
                  id="rec-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.avgAmountDollars}
                  onChange={(e) => setForm((f) => ({ ...f, avgAmountDollars: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Select
                value={form.categoryId}
                onValueChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {(categoriesQuery.data?.categories ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{form.kind === "income" ? "Deposit account" : "Paid from"}</Label>
              <Select
                value={form.accountId}
                onValueChange={(v) => setForm((f) => ({ ...f, accountId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {depositoryAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.accountId === "none" && form.kind === "income" ? (
                <p className="text-xs text-fin-warning">
                  Linking this account lets payment-plan funding checks count this income toward the
                  projected balance — otherwise those checks assume no income lands in that account.
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rec-notes">Notes</Label>
              <Textarea
                id="rec-notes"
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
            <Button
              onClick={submitForm}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
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
              This removes the recurring entry. Linked transactions keep their history.
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
