/**
 * Duplicate transaction review panel: lists groups found by
 * find-duplicate-transactions (grouped by confidence), lets the user select
 * which groups to consolidate (high-confidence pre-checked), and calls
 * consolidate-duplicates on confirmation. Opened from /transactions (and
 * /accounts, scoped to one account).
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate, formatMoney } from "@/lib/finance-format";

interface DupeSummary {
  id: string;
  accountId: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amountCents: number;
  source: "plaid" | "imported";
  pending: boolean;
  note: string | null;
  categoryId: string | null;
}
interface DuplicateGroup {
  id: string;
  accountId: string;
  crossAccount: boolean;
  confidence: "high" | "medium";
  survivor: DupeSummary;
  losers: DupeSummary[];
}
interface FindDuplicatesResult {
  groupCount: number;
  byConfidence: { high: number; medium: number };
  groups: DuplicateGroup[];
}

function sourceBadge(source: DupeSummary["source"]) {
  if (source === "imported") return { label: "Import", variant: "outline" as const };
  return { label: "Plaid", variant: "default" as const };
}

function RowLine({
  row,
  isSurvivor,
  accountLabel,
}: {
  row: DupeSummary;
  isSurvivor: boolean;
  accountLabel?: string;
}) {
  const badge = sourceBadge(row.source);
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <Badge variant={isSurvivor ? "default" : "outline"} className="shrink-0 text-[9px]">
        {isSurvivor ? "Keep" : "Remove"}
      </Badge>
      <Badge variant={badge.variant} className="shrink-0 text-[9px]">
        {badge.label}
      </Badge>
      <span className="text-muted-foreground">{formatDate(row.date)}</span>
      <span className="min-w-0 flex-1 truncate">{row.merchantName || row.name || "Unknown"}</span>
      {accountLabel ? (
        <span className="shrink-0 truncate text-muted-foreground">{accountLabel}</span>
      ) : null}
      <span className="shrink-0 font-medium tabular-nums">{formatMoney(Math.abs(row.amountCents) / 100)}</span>
      {row.pending ? (
        <Badge variant="secondary" className="shrink-0 text-[9px]">
          Pending
        </Badge>
      ) : null}
    </div>
  );
}

function GroupCard({
  group,
  checked,
  onToggle,
  accountLabelById,
}: {
  group: DuplicateGroup;
  checked: boolean;
  onToggle: (next: boolean) => void;
  accountLabelById?: Map<string, string>;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <Checkbox checked={checked} onCheckedChange={(v) => onToggle(Boolean(v))} aria-label="Include this group" />
        <Badge variant={group.confidence === "high" ? "default" : "secondary"} className="text-[10px]">
          {group.confidence} confidence
        </Badge>
        {group.crossAccount ? (
          <Badge variant="outline" className="text-[10px]">
            Cross-account
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {group.losers.length} duplicate{group.losers.length === 1 ? "" : "s"} would be removed
        </span>
      </div>
      <div className="divide-y divide-border/60">
        <RowLine
          row={group.survivor}
          isSurvivor
          accountLabel={group.crossAccount ? accountLabelById?.get(group.survivor.accountId) : undefined}
        />
        {group.losers.map((l) => (
          <RowLine
            key={l.id}
            row={l}
            isSurvivor={false}
            accountLabel={group.crossAccount ? accountLabelById?.get(l.accountId) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

interface ListAccountsResult {
  id: string;
  name: string;
  accounts: Array<{ id: string; name: string | null; type: string | null; mask: string | null }>;
}

export function DuplicatesPanel({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Scope to one account (e.g. from /accounts); omit to scan everything. */
  accountId?: string;
}) {
  const [crossAccounts, setCrossAccounts] = useState(false);

  const findQuery = useActionQuery<FindDuplicatesResult>(
    "find-duplicate-transactions",
    { accountId, limit: 500, crossAccounts },
    { enabled: open },
  );
  const accountsQuery = useActionQuery<ListAccountsResult[]>("list-accounts", {}, { enabled: open });
  const consolidateMutation = useActionMutation("consolidate-duplicates");

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groups = findQuery.data?.groups ?? [];

  const accountLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const inst of accountsQuery.data ?? []) {
      for (const a of inst.accounts) {
        map.set(a.id, `${inst.name} · ${a.name ?? a.type ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}`);
      }
    }
    return map;
  }, [accountsQuery.data]);

  // Pre-check every high-confidence group whenever fresh data loads.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(groups.filter((g) => g.confidence === "high").map((g) => g.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, findQuery.data]);

  const highGroups = useMemo(() => groups.filter((g) => g.confidence === "high"), [groups]);
  const mediumGroups = useMemo(() => groups.filter((g) => g.confidence === "medium"), [groups]);

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  function consolidateSelected() {
    const groupIds = Array.from(selected);
    if (groupIds.length === 0) {
      toast.error("Select at least one group to consolidate.");
      return;
    }
    consolidateMutation.mutate(
      { accountId, groupIds, minConfidence: "medium", crossAccounts, dryRun: false },
      {
        onSuccess: (result: { transactionsRemoved: number; groupsConsidered: number }) => {
          toast.success(
            `Removed ${result.transactionsRemoved} duplicate transaction${result.transactionsRemoved === 1 ? "" : "s"} across ${result.groupsConsidered} group${result.groupsConsidered === 1 ? "" : "s"}.`,
          );
          setSelected(new Set());
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not consolidate duplicates"),
      },
    );
  }

  function consolidateAllHigh() {
    consolidateMutation.mutate(
      { accountId, minConfidence: "high", crossAccounts, dryRun: false },
      {
        onSuccess: (result: { transactionsRemoved: number; groupsConsidered: number }) => {
          toast.success(
            `Removed ${result.transactionsRemoved} duplicate transaction${result.transactionsRemoved === 1 ? "" : "s"} (${result.groupsConsidered} high-confidence group${result.groupsConsidered === 1 ? "" : "s"}).`,
          );
          setSelected(new Set());
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not consolidate duplicates"),
      },
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="text-left">
          <SheetTitle>Find duplicates</SheetTitle>
          <SheetDescription>
            Same amount, close dates, similar merchant — likely the same real charge counted twice
            (merged Plaid connections, or a CSV import overlapping Plaid history).
          </SheetDescription>
        </SheetHeader>

        <TooltipProvider>
          <div className="mt-3 flex items-center gap-2">
            <Switch id="cross-accounts" checked={crossAccounts} onCheckedChange={setCrossAccounts} />
            <label htmlFor="cross-accounts" className="text-sm font-medium">
              Search across accounts
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconAlertTriangle className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64 text-xs">
                Also looks for the same real charge duplicated on a DIFFERENT account (e.g. the
                same bank login connected twice). Capped at medium confidence by default since a
                same-day, same-amount charge across two accounts can legitimately be unrelated
                (e.g. a transfer).
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>

        <div className="mt-4 space-y-4">
          {findQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No likely duplicates found.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={highGroups.length === 0 || consolidateMutation.isPending}
                  onClick={consolidateAllHigh}
                >
                  Consolidate all high ({highGroups.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selected.size === 0 || consolidateMutation.isPending}
                  onClick={consolidateSelected}
                >
                  Consolidate selected ({selected.size})
                </Button>
              </div>

              {highGroups.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    High confidence ({highGroups.length})
                  </p>
                  {highGroups.map((g) => (
                    <GroupCard
                      key={g.id}
                      group={g}
                      checked={selected.has(g.id)}
                      onToggle={(next) => toggle(g.id, next)}
                      accountLabelById={accountLabelById}
                    />
                  ))}
                </div>
              ) : null}

              {mediumGroups.length > 0 ? (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <IconAlertTriangle className="size-3.5" />
                    Medium confidence ({mediumGroups.length}) — review individually
                  </p>
                  {mediumGroups.map((g) => (
                    <GroupCard
                      key={g.id}
                      group={g}
                      checked={selected.has(g.id)}
                      onToggle={(next) => toggle(g.id, next)}
                      accountLabelById={accountLabelById}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
