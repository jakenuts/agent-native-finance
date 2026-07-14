/**
 * /projections — Quicken-style projected-income ledger: expected future cash
 * events (manual entries + optional Recurly renewal sources). Upcoming entries
 * grouped by date, a past-due section for manual resolution, add/edit dialogs,
 * a Recurly-renewals CSV import dialog (dryRun preview → import), projection
 * source status, and a "Resolve stale" menu. Everything here is backed 1:1 by
 * agent actions (list/create/update/delete-projected-entry,
 * list-projection-sources, import-recurly-renewals, resolve-stale-projections).
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconClockX,
  IconEdit,
  IconFileText,
  IconPlus,
  IconTrash,
  IconTrendingUp,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
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
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { APP_TITLE } from "@/lib/app-config";
import { formatDate, formatMoney } from "@/lib/finance-format";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Projections - ${APP_TITLE}` }];
}

// Keep in sync with actions/import-recurly-renewals.ts MAX_CSV_BYTES.
const MAX_CSV_BYTES = 5 * 1024 * 1024;

type EntryStatus = "projected" | "received" | "missed" | "canceled";
type EntrySource = "manual" | "recurly-import" | "api";

interface ProjectedEntry {
  id: string;
  date: string;
  name: string;
  amountCents: number;
  amount: number;
  source: EntrySource;
  status: EntryStatus;
  accountId: string | null;
  accountName: string | null;
  notes: string | null;
  pastDue: boolean;
  staleExcluded: boolean;
}

interface ListProjectedResult {
  entries: ProjectedEntry[];
  count: number;
  pastDueCount: number;
  next30dProjectedIncomeCents: number;
  windowProjectedIncomeCents: number;
}

interface AccountOption {
  id: string;
  name: string | null;
  type: string | null;
  mask: string | null;
  profile: string;
}
interface InstitutionRow {
  id: string;
  name: string;
  accounts: AccountOption[];
}

interface ImportSummary {
  ok: true;
  dryRun: boolean;
  parsed: number;
  skippedFree: number;
  skippedInvalid: number;
  created: number;
  updated: number;
  unchanged: number;
  dateFrom: string | null;
  dateTo: string | null;
  totalProjectedCents: number;
  source: string;
}

interface SelectedFile {
  name: string;
  size: number;
  text: string;
}

const STATUS_STYLE: Record<EntryStatus, string> = {
  projected: "border-primary/40 text-primary",
  received: "border-fin-positive/40 text-fin-positive",
  missed: "border-destructive/40 text-destructive",
  canceled: "border-border text-muted-foreground",
};

const SOURCE_LABEL: Record<EntrySource, string> = {
  manual: "manual",
  "recurly-import": "recurly",
  api: "api",
};

interface EntryFormState {
  date: string;
  amountDollars: string;
  direction: "income" | "outflow";
  name: string;
  accountId: string;
  notes: string;
  status: EntryStatus;
}

const EMPTY_FORM: EntryFormState = {
  date: new Date().toISOString().slice(0, 10),
  amountDollars: "",
  direction: "income",
  name: "",
  accountId: "none",
  notes: "",
  status: "projected",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface RecentRenewalActivity {
  windowDays: number;
  succeeded: { count: number; total: number };
  failed: { count: number; total: number };
}

interface ProjectionSourceStatus {
  id: string;
  label: string;
  kind: "manual" | "csv" | "api";
  configured: boolean;
  automated: boolean;
  description: string;
  action: string;
  missingEnv: string[];
}

interface ProjectionSourcesResult {
  sources: ProjectionSourceStatus[];
  automatedAvailable: boolean;
}

export default function ProjectionsRoute() {
  useSetPageTitle("Projections");
  const queryClient = useQueryClient();

  const listQuery = useActionQuery<ListProjectedResult>("list-projected-entries", {});
  const accountsQuery = useActionQuery<InstitutionRow[]>("list-accounts", { profile: "all" });
  const sourceStatusQuery = useActionQuery<ProjectionSourcesResult>("list-projection-sources", {});
  // Actual recent renewal outcomes straight from Recurly (succeeded/failed over
  // the last 3 days). Silently absent when the Recurly API source isn't configured.
  const recentActivityQuery = useActionQuery<RecentRenewalActivity>("recurly-recent-activity", {
    days: 3,
  });

  const createMutation = useActionMutation("create-projected-entry");
  const updateMutation = useActionMutation("update-projected-entry");
  const deleteMutation = useActionMutation("delete-projected-entry");
  const previewMutation = useActionMutation("import-recurly-renewals");
  const importMutation = useActionMutation("import-recurly-renewals");
  const resolveStaleMutation = useActionMutation("resolve-stale-projections");

  const [editing, setEditing] = useState<ProjectedEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<EntryFormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<ProjectedEntry | null>(null);
  const [staleAction, setStaleAction] = useState<"missed" | "delete" | null>(null);

  // Import dialog state.
  const [importOpen, setImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [importAccountId, setImportAccountId] = useState<string | null>(null);
  const [payoutLag, setPayoutLag] = useState("2");
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);

  const accountOptions = useMemo(
    () =>
      (accountsQuery.data ?? []).flatMap((inst) =>
        inst.accounts.map((a) => ({
          id: a.id,
          type: a.type,
          profile: a.profile,
          label: `${inst.name} · ${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}`,
        })),
      ),
    [accountsQuery.data],
  );

  // Default import target: first BUSINESS depository account (renewal payouts
  // hit business checking), falling back to any depository account.
  const defaultImportAccountId = useMemo(() => {
    const depository = accountOptions.filter((a) => a.type === "depository" || a.type == null);
    return (
      depository.find((a) => a.profile === "business")?.id ?? depository[0]?.id ?? null
    );
  }, [accountOptions]);
  const selectedImportAccountId = importAccountId ?? defaultImportAccountId;

  const data = listQuery.data;
  const entries = data?.entries ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const upcoming = useMemo(
    () => entries.filter((e) => e.status === "projected" && !e.pastDue),
    [entries],
  );
  const pastDue = useMemo(() => entries.filter((e) => e.pastDue), [entries]);
  const resolved = useMemo(
    () => entries.filter((e) => e.status !== "projected"),
    [entries],
  );

  const upcomingByDate = useMemo(() => {
    const groups = new Map<string, ProjectedEntry[]>();
    for (const e of upcoming) {
      const list = groups.get(e.date) ?? [];
      list.push(e);
      groups.set(e.date, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [upcoming]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["action"] });
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreating(true);
  }

  function openEdit(entry: ProjectedEntry) {
    setForm({
      date: entry.date,
      amountDollars: String(Math.abs(entry.amountCents) / 100),
      direction: entry.amountCents < 0 ? "income" : "outflow",
      name: entry.name,
      accountId: entry.accountId ?? "none",
      notes: entry.notes ?? "",
      status: entry.status,
    });
    setEditing(entry);
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  function submitForm() {
    const dollars = Number(form.amountDollars);
    if (!form.name.trim() || !Number.isFinite(dollars) || dollars === 0) {
      toast.error("Name and a non-zero amount are required.");
      return;
    }
    const signedCents =
      form.direction === "income"
        ? -Math.round(Math.abs(dollars) * 100)
        : Math.round(Math.abs(dollars) * 100);

    if (editing) {
      updateMutation.mutate(
        {
          id: editing.id,
          date: form.date,
          amountCents: signedCents,
          name: form.name.trim(),
          accountId: form.accountId === "none" ? null : form.accountId,
          notes: form.notes.trim() || null,
          status: form.status,
        },
        {
          onSuccess: () => {
            toast.success(`Updated "${form.name.trim()}"`);
            closeForm();
            invalidate();
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
        },
      );
    } else {
      createMutation.mutate(
        {
          date: form.date,
          amountCents: signedCents,
          name: form.name.trim(),
          ...(form.accountId !== "none" ? { accountId: form.accountId } : {}),
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        },
        {
          onSuccess: () => {
            toast.success(`Added "${form.name.trim()}"`);
            closeForm();
            invalidate();
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create"),
        },
      );
    }
  }

  function setStatus(entry: ProjectedEntry, status: EntryStatus) {
    updateMutation.mutate(
      { id: entry.id, status },
      {
        onSuccess: () => {
          toast.success(`Marked "${entry.name}" ${status}`);
          invalidate();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
      },
    );
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          toast.success(`Deleted "${deleteTarget.name}"`);
          setDeleteTarget(null);
          invalidate();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete"),
      },
    );
  }

  function runResolveStale() {
    if (!staleAction) return;
    resolveStaleMutation.mutate(
      { olderThanDays: 7, action: staleAction },
      {
        onSuccess: (result) => {
          const r = result as { matched: number };
          toast.success(
            r.matched === 0
              ? "No stale projections found."
              : `${staleAction === "delete" ? "Deleted" : "Marked missed"} ${r.matched} stale projection${r.matched === 1 ? "" : "s"}.`,
          );
          setStaleAction(null);
          invalidate();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not resolve"),
      },
    );
  }

  // --- Import dialog handlers ------------------------------------------
  async function ingestFile(picked: File) {
    if (!picked.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please choose a .csv file.");
      return;
    }
    if (picked.size > MAX_CSV_BYTES) {
      toast.error(`File is too large (max ${Math.round(MAX_CSV_BYTES / (1024 * 1024))}MB).`);
      return;
    }
    let text: string;
    try {
      text = await picked.text();
    } catch {
      toast.error("Could not read that file. Try choosing it again.");
      return;
    }
    if (text.trim().length === 0) {
      toast.error("That file is empty.");
      return;
    }
    setPreview(null);
    setImportResult(null);
    setFile({ name: picked.name, size: picked.size, text });
  }

  function clearFile() {
    setFile(null);
    setPreview(null);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function closeImportDialog() {
    setImportOpen(false);
    clearFile();
  }

  function handlePreview() {
    if (!file) {
      toast.error("Choose a CSV file first.");
      return;
    }
    setImportResult(null);
    previewMutation.mutate(
      {
        csvText: file.text,
        fileName: file.name,
        ...(selectedImportAccountId ? { accountId: selectedImportAccountId } : {}),
        payoutLagDays: Math.max(0, Math.round(Number(payoutLag || "2"))),
        dryRun: true,
      },
      {
        onSuccess: (result) => setPreview(result as ImportSummary),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Preview failed."),
      },
    );
  }

  function handleImport() {
    if (!file || !preview) return;
    importMutation.mutate(
      {
        csvText: file.text,
        fileName: file.name,
        ...(selectedImportAccountId ? { accountId: selectedImportAccountId } : {}),
        payoutLagDays: Math.max(0, Math.round(Number(payoutLag || "2"))),
        dryRun: false,
      },
      {
        onSuccess: (result) => {
          const summary = result as ImportSummary;
          setImportResult(summary);
          setPreview(null);
          invalidate();
          toast.success(
            `Imported ${summary.created} new, updated ${summary.updated}, unchanged ${summary.unchanged}.`,
          );
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Import failed."),
      },
    );
  }

  const isImportBusy = previewMutation.isPending || importMutation.isPending;
  const isLoading = listQuery.isLoading;

  function EntryRow({ entry, showDate }: { entry: ProjectedEntry; showDate?: boolean }) {
    const isIncome = entry.amountCents < 0;
    return (
      <div className="flex items-center gap-3 rounded-lg px-0 py-2 transition-colors hover:bg-accent/50 sm:px-2">
        {showDate ? (
          <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDate(entry.date)}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{entry.name}</p>
            <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
              {SOURCE_LABEL[entry.source]}
            </Badge>
            {entry.staleExcluded ? (
              <Badge
                variant="outline"
                className="shrink-0 border-fin-warning/40 text-[10px] text-fin-warning"
              >
                stale — excluded from runway
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {entry.accountName ?? "No account"}
            {entry.notes ? ` · ${entry.notes}` : ""}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 text-sm font-semibold tabular-nums",
            isIncome ? "text-fin-positive" : "text-destructive",
          )}
        >
          {isIncome ? "+" : "-"}
          {formatMoney(Math.abs(entry.amount))}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
                STATUS_STYLE[entry.status],
              )}
              aria-label={`Status: ${entry.status}`}
            >
              {entry.status}
              <IconChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {entry.status !== "received" ? (
              <DropdownMenuItem onSelect={() => setStatus(entry, "received")}>
                <IconCheck className="size-4" /> Mark received
              </DropdownMenuItem>
            ) : null}
            {entry.status !== "missed" ? (
              <DropdownMenuItem onSelect={() => setStatus(entry, "missed")}>
                <IconX className="size-4" /> Mark missed
              </DropdownMenuItem>
            ) : null}
            {entry.status !== "canceled" ? (
              <DropdownMenuItem onSelect={() => setStatus(entry, "canceled")}>
                <IconX className="size-4" /> Mark canceled
              </DropdownMenuItem>
            ) : null}
            {entry.status !== "projected" ? (
              <DropdownMenuItem onSelect={() => setStatus(entry, "projected")}>
                <IconTrendingUp className="size-4" /> Re-arm as projected
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={() => openEdit(entry)}
          aria-label="Edit"
        >
          <IconEdit className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => setDeleteTarget(entry)}
          aria-label="Delete"
        >
          <IconTrash className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projections</h1>
          <p className="text-sm text-muted-foreground">
            Expected future income — upcoming subscription renewals and other scheduled cash.
            Estimates, not promises; they flow into the{" "}
            <Link to="/runway" className="underline">
              runway
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <IconClockX className="size-4" />
                Resolve stale
                <IconChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setStaleAction("missed")}>
                Mark past-due (&gt;7d) as missed
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                onSelect={() => setStaleAction("delete")}
              >
                Delete past-due (&gt;7d)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setImportOpen(true);
            }}
          >
            <IconUpload className="size-4" />
            Import renewals CSV
          </Button>
          <Button size="sm" onClick={openCreate}>
            <IconPlus className="size-4" />
            Add entry
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Projected income (next 30 days)</CardDescription>
            {isLoading ? (
              <Skeleton className="h-8 w-28" />
            ) : (
              <CardTitle className="text-2xl tabular-nums text-fin-positive">
                {formatMoney((data?.next30dProjectedIncomeCents ?? 0) / 100)}
              </CardTitle>
            )}
          </CardHeader>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Upcoming entries</CardDescription>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <CardTitle className="text-2xl tabular-nums">{upcoming.length}</CardTitle>
            )}
          </CardHeader>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>Past due</CardDescription>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <CardTitle
                className={cn(
                  "text-2xl tabular-nums",
                  pastDue.length > 0 ? "text-fin-warning" : undefined,
                )}
              >
                {pastDue.length}
              </CardTitle>
            )}
          </CardHeader>
        </Card>
      </div>

      {recentActivityQuery.data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription>
                Renewals succeeded (last {recentActivityQuery.data.windowDays}d)
              </CardDescription>
              <CardTitle className="text-2xl tabular-nums text-fin-positive">
                {formatMoney(recentActivityQuery.data.succeeded.total)}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {recentActivityQuery.data.succeeded.count} charge
                {recentActivityQuery.data.succeeded.count === 1 ? "" : "s"} collected
              </p>
            </CardHeader>
          </Card>
          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardDescription>
                Renewals failed (last {recentActivityQuery.data.windowDays}d)
              </CardDescription>
              <CardTitle
                className={cn(
                  "text-2xl tabular-nums",
                  recentActivityQuery.data.failed.count > 0 ? "text-fin-warning" : undefined,
                )}
              >
                {formatMoney(recentActivityQuery.data.failed.total)}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {recentActivityQuery.data.failed.count} declined / errored
              </p>
            </CardHeader>
          </Card>
        </div>
      ) : null}

      {sourceStatusQuery.data ? (
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Projection sources</CardTitle>
            <CardDescription>
              {sourceStatusQuery.data.automatedAvailable
                ? "Automated refresh is available."
                : "Manual entries and CSV import are available; API automation is optional."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {sourceStatusQuery.data.sources.map((source) => (
              <div
                key={source.id}
                className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-border/70 p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{source.label}</p>
                    {source.automated ? (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        automated
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {source.description}
                  </p>
                  <p className="mt-2 truncate text-[11px] text-muted-foreground">
                    {source.missingEnv.length > 0
                      ? `Needs ${source.missingEnv.join(", ")}`
                      : source.action}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0 text-[10px]",
                    source.configured
                      ? "border-fin-positive/40 text-fin-positive"
                      : "border-fin-warning/40 text-fin-warning",
                  )}
                >
                  {source.configured ? "Ready" : "Setup"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <IconTrendingUp className="size-4 text-muted-foreground" />
                Upcoming
              </CardTitle>
              <CardDescription>Grouped by expected bank date (renewal + payout lag).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {upcomingByDate.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nothing projected yet. Import a Recurly renewals CSV or add an entry.
                </p>
              ) : (
                upcomingByDate.map(([date, dayEntries]) => {
                  const dayIncome = dayEntries
                    .filter((e) => e.amountCents < 0)
                    .reduce((s, e) => s + Math.abs(e.amountCents), 0);
                  return (
                    <div key={date}>
                      <div className="flex items-center justify-between border-b border-border/60 px-2 pb-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {formatDate(date)}
                          {date === today ? " · today" : ""}
                        </p>
                        <p className="text-xs font-medium tabular-nums text-fin-positive">
                          +{formatMoney(dayIncome / 100)}
                        </p>
                      </div>
                      <div className="space-y-0.5 pt-1">
                        {dayEntries.map((entry) => (
                          <EntryRow key={entry.id} entry={entry} />
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          {pastDue.length > 0 ? (
            <Card className="rounded-2xl border-fin-warning/40 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 text-fin-warning">
                  <IconAlertTriangle className="size-4" />
                  Past due
                </CardTitle>
                <CardDescription>
                  Projected entries whose expected date passed. Mark received if the money landed,
                  missed if it didn't — entries more than 7 days past due stop counting toward the
                  runway automatically.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-0.5">
                {pastDue.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} showDate />
                ))}
              </CardContent>
            </Card>
          ) : null}

          {resolved.length > 0 ? (
            <Card className="rounded-2xl shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Resolved</CardTitle>
                <CardDescription>Received, missed, or canceled entries.</CardDescription>
              </CardHeader>
              <CardContent className="max-h-80 space-y-0.5 overflow-y-auto">
                {resolved
                  .slice()
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .map((entry) => (
                    <EntryRow key={entry.id} entry={entry} showDate />
                  ))}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      {/* Add / edit dialog */}
      <Dialog open={creating || editing !== null} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit projected entry" : "Add projected entry"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this expected cash event."
                : "Track money you expect to arrive (or leave) on a specific date."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="proj-name">Name</Label>
              <Input
                id="proj-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Example Customer · Elite"
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="proj-date">Expected bank date</Label>
                <Input
                  id="proj-date"
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="proj-amount">Amount ($)</Label>
                <Input
                  id="proj-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.amountDollars}
                  onChange={(e) => setForm((f) => ({ ...f, amountDollars: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Direction</Label>
                <Select
                  value={form.direction}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, direction: v as "income" | "outflow" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="income">Income</SelectItem>
                    <SelectItem value="outflow">Outflow</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Target account</Label>
              <Select
                value={form.accountId}
                onValueChange={(v) => setForm((f) => ({ ...f, accountId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {accountOptions.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.accountId === "none" ? (
                <p className="text-xs text-fin-warning">
                  Linking the account the money hits lets the runway and plan funding checks
                  attribute this income precisely.
                </p>
              ) : null}
            </div>
            {editing ? (
              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm((f) => ({ ...f, status: v as EntryStatus }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="projected">Projected</SelectItem>
                    <SelectItem value="received">Received</SelectItem>
                    <SelectItem value="missed">Missed</SelectItem>
                    <SelectItem value="canceled">Canceled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="proj-notes">Notes</Label>
              <Textarea
                id="proj-notes"
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

      {/* Import renewals CSV dialog */}
      <Dialog open={importOpen} onOpenChange={(open) => !open && closeImportDialog()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Recurly renewals</DialogTitle>
            <DialogDescription>
              Upload the upcoming-renewals CSV export. Free ($0) plans are skipped; each renewal
              lands as projected income on renewal date + payout lag. Re-importing is safe —
              existing entries update instead of duplicating.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) void ingestFile(picked);
              }}
            />
            {file ? (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
                <IconFileText className="size-8 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={clearFile}
                  disabled={isImportBusy}
                  aria-label="Remove file"
                >
                  <IconX className="size-4" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-6 text-center transition-colors hover:border-primary/50 hover:bg-accent/30"
              >
                <IconUpload className="size-7 text-muted-foreground" />
                <span className="text-sm font-medium">Drop or choose the renewals .csv</span>
              </button>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label>Deposit account</Label>
                <Select
                  value={selectedImportAccountId ?? "none"}
                  onValueChange={(v) => setImportAccountId(v === "none" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose account" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not linked</SelectItem>
                    {accountOptions
                      .filter((a) => a.type === "depository" || a.type == null)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="proj-lag">Payout lag (days)</Label>
                <Input
                  id="proj-lag"
                  type="number"
                  min="0"
                  max="30"
                  step="1"
                  value={payoutLag}
                  onChange={(e) => setPayoutLag(e.target.value)}
                />
              </div>
            </div>

            {preview ? (
              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Preview (dry run)
                </p>
                <Table>
                  <TableBody>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Billable renewals</TableCell>
                      <TableCell className="text-right tabular-nums">{preview.parsed}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Skipped free plans</TableCell>
                      <TableCell className="text-right tabular-nums">{preview.skippedFree}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">New / updated / unchanged</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {preview.created} / {preview.updated} / {preview.unchanged}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Expected bank dates</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {preview.dateFrom && preview.dateTo
                          ? `${formatDate(preview.dateFrom)} – ${formatDate(preview.dateTo)}`
                          : "—"}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium">Total projected income</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-fin-positive">
                        {formatMoney(preview.totalProjectedCents / 100)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            ) : null}

            {importResult ? (
              <div className="rounded-xl border border-fin-positive/40 bg-fin-positive/5 p-3 text-sm">
                Imported: {importResult.created} new, {importResult.updated} updated,{" "}
                {importResult.unchanged} unchanged ({importResult.skippedFree} free plans skipped).
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeImportDialog}>
              {importResult ? "Done" : "Cancel"}
            </Button>
            <Button variant="outline" disabled={isImportBusy || !file} onClick={handlePreview}>
              {previewMutation.isPending ? "Previewing..." : "Preview"}
            </Button>
            <Button disabled={isImportBusy || !file || !preview || !!importResult} onClick={handleImport}>
              <IconUpload className="size-4" />
              {importMutation.isPending ? "Importing..." : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconAlertTriangle className="size-5 text-destructive" />
              Delete "{deleteTarget?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes this projected entry. A re-import of the same renewals CSV would recreate an
              imported entry — mark it canceled instead to keep it suppressed.
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

      {/* Resolve stale confirm */}
      <AlertDialog open={staleAction !== null} onOpenChange={(open) => !open && setStaleAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {staleAction === "delete" ? "Delete stale projections?" : "Mark stale projections as missed?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Applies to entries still "projected" more than 7 days past their expected date —
              renewals that never landed.{" "}
              {staleAction === "delete"
                ? "Deleting removes them; a re-import would recreate them."
                : "Marking missed keeps the history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                staleAction === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={runResolveStale}
            >
              {staleAction === "delete" ? "Delete" : "Mark missed"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
