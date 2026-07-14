/**
 * /rules — manage auto-categorization rules: priority-ordered list with
 * readable summaries, enabled toggle, on-demand match count, edit/delete,
 * and the shared RuleDialog (create/edit + live preview + apply-to-existing).
 */
import { useActionMutation, useActionQuery, callAction } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconEdit,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { RuleDialog, type RuleFormValue } from "@/components/finance/RuleDialog";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { APP_TITLE } from "@/lib/app-config";
import { formatMoney } from "@/lib/finance-format";

export function meta() {
  return [{ title: `Rules - ${APP_TITLE}` }];
}

interface RuleRow {
  id: string;
  priority: number;
  isEnabled: boolean;
  matchName: string | null;
  matchNameMode: string | null;
  matchNameExclude: string | null;
  invalid: boolean;
  matchAccountId: string | null;
  matchMinCents: number | null;
  matchMaxCents: number | null;
  setCategoryId: string | null;
  setCategoryName: string | null;
  setMerchantName: string | null;
  createdAt: string;
}
interface ListRulesResult {
  rules: RuleRow[];
}

function summarize(rule: RuleRow): string {
  const matchParts: string[] = [];
  if (rule.matchName) {
    matchParts.push(
      rule.matchNameMode === "exact"
        ? `name is "${rule.matchName}"`
        : rule.matchNameMode === "regex"
          ? `name matches /${rule.matchName}/i`
          : `name contains "${rule.matchName}"`,
    );
    if (rule.matchNameExclude) {
      matchParts.push(`not containing "${rule.matchNameExclude}"`);
    }
  }
  if (rule.matchAccountId) matchParts.push("account matches");
  if (rule.matchMinCents != null) matchParts.push(`amount ≥ ${formatMoney(rule.matchMinCents / 100)}`);
  if (rule.matchMaxCents != null) matchParts.push(`amount ≤ ${formatMoney(rule.matchMaxCents / 100)}`);
  const matchText = matchParts.length > 0 ? matchParts.join(" and ") : "any transaction";

  const effectParts: string[] = [];
  if (rule.setCategoryName) effectParts.push(`category ${rule.setCategoryName}`);
  if (rule.setMerchantName) effectParts.push(`rename to "${rule.setMerchantName}"`);
  const effectText = effectParts.length > 0 ? effectParts.join(", ") : "no effect";

  return `If ${matchText} → ${effectText}`;
}

function RuleRowItem({
  rule,
  onEdit,
  onDelete,
  onToggle,
  onMove,
  isFirst,
  isLast,
  moveDisabled,
}: {
  rule: RuleRow;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (next: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
  moveDisabled: boolean;
}) {
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  async function checkMatches() {
    setChecking(true);
    try {
      const res = await callAction<{ matchedCount: number }>(
        "apply-rules",
        { ruleId: rule.id, dryRun: true },
        { method: "POST" },
      );
      setMatchCount(res.matchedCount);
    } catch {
      setMatchCount(null);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/50">
      <div className="flex shrink-0 flex-col">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 sm:size-6"
          disabled={isFirst || moveDisabled}
          onClick={() => onMove(-1)}
          aria-label="Move up (higher priority)"
        >
          <IconArrowUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 sm:size-6"
          disabled={isLast || moveDisabled}
          onClick={() => onMove(1)}
          aria-label="Move down (lower priority)"
        >
          <IconArrowDown className="size-3.5" />
        </Button>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{summarize(rule)}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            priority {rule.priority}
          </Badge>
          {rule.invalid ? (
            <Badge variant="destructive" className="gap-1 text-[10px]">
              <IconAlertTriangle className="size-3" />
              Invalid regex
            </Badge>
          ) : null}
          {matchCount === null ? (
            <button
              type="button"
              onClick={checkMatches}
              disabled={checking}
              className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              {checking ? "Checking..." : "Check matches"}
            </button>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              {matchCount} match{matchCount === 1 ? "" : "es"}
            </Badge>
          )}
        </div>
      </div>
      <Switch checked={rule.isEnabled} onCheckedChange={onToggle} aria-label="Enabled" className="shrink-0" />
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
  );
}

export default function RulesRoute() {
  useSetPageTitle("Rules");

  const listQuery = useActionQuery<ListRulesResult>("list-rules", {});
  const updateMutation = useActionMutation("update-rule");
  const deleteMutation = useActionMutation("delete-rule");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RuleFormValue | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuleRow | null>(null);

  const rules = [...(listQuery.data?.rules ?? [])].sort((a, b) => a.priority - b.priority);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(rule: RuleRow) {
    setEditing({
      id: rule.id,
      matchName: rule.matchName ?? "",
      matchNameMode: (rule.matchNameMode as "contains" | "exact" | "regex") ?? "contains",
      matchNameExclude: rule.matchNameExclude ?? "",
      matchAccountId: rule.matchAccountId ?? "none",
      matchMinDollars: rule.matchMinCents != null ? String(rule.matchMinCents / 100) : "",
      matchMaxDollars: rule.matchMaxCents != null ? String(rule.matchMaxCents / 100) : "",
      setCategoryId: rule.setCategoryId ?? "none",
      setMerchantName: rule.setMerchantName ?? "",
      priority: rule.priority,
    });
    setDialogOpen(true);
  }

  function toggleEnabled(rule: RuleRow, next: boolean) {
    updateMutation.mutate(
      { id: rule.id, isEnabled: next },
      { onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update") },
    );
  }

  // Reordering swaps priority VALUES between two adjacent rules. When rules
  // share the same priority (common from seed data / repeated manual edits),
  // a naive swap is a no-op — order looks unchanged after clicking the arrow.
  // Fix: always renumber the FULL list to unique, evenly spaced priorities
  // (10, 20, 30...) first, swap the two entries in that normalized order,
  // then persist every changed priority. This also makes future reorders
  // reliable since priorities stay unique after the first click.
  const [reordering, setReordering] = useState(false);

  // Fires updates ONE AT A TIME through the shared `updateMutation` hook.
  // useActionMutation wraps a single React Query useMutation instance, whose
  // isPending reflects only the MOST RECENTLY triggered call — firing
  // several mutate() calls concurrently on that one instance races (a later
  // call's settle can flip isPending before an earlier one has actually
  // finished, or vice versa), which was leaving the move buttons stuck
  // disabled. Sequencing through this local async loop keeps the framework
  // hook to one in-flight call at a time; `reordering` (not
  // updateMutation.isPending) is the single source of truth for the
  // disabled UI state.
  async function move(rule: RuleRow, direction: -1 | 1) {
    if (reordering) return;
    const idx = rules.findIndex((r) => r.id === rule.id);
    const otherIdx = idx + direction;
    if (otherIdx < 0 || otherIdx >= rules.length) return;

    // Normalize to unique spaced values in current display order, then swap.
    const normalized = rules.map((r, i) => ({ id: r.id, priority: (i + 1) * 10 }));
    const tmp = normalized[idx].priority;
    normalized[idx].priority = normalized[otherIdx].priority;
    normalized[otherIdx].priority = tmp;

    // Only push updates for rows whose priority actually changed.
    const changes = normalized.filter((n) => {
      const original = rules.find((r) => r.id === n.id);
      return original && original.priority !== n.priority;
    });
    if (changes.length === 0) return;

    setReordering(true);
    try {
      for (const c of changes) {
        await new Promise<void>((resolve) => {
          updateMutation.mutate(
            { id: c.id, priority: c.priority },
            {
              onSettled: () => resolve(),
              onError: (err) => toast.error(err instanceof Error ? err.message : "Could not reorder"),
            },
          );
        });
      }
    } finally {
      setReordering(false);
    }
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          toast.success("Rule deleted");
          setDeleteTarget(null);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete"),
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted-foreground">
            Auto-categorization rules, applied in priority order — first match wins.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <IconPlus className="size-4" />
          Create rule
        </Button>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="space-y-1 p-3">
          {listQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : rules.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No rules yet. Create one to auto-categorize future transactions.
            </p>
          ) : (
            rules.map((rule, i) => (
              <RuleRowItem
                key={rule.id}
                rule={rule}
                onEdit={() => openEdit(rule)}
                onDelete={() => setDeleteTarget(rule)}
                onToggle={(next) => toggleEnabled(rule, next)}
                onMove={(direction) => move(rule, direction)}
                isFirst={i === 0}
                isLast={i === rules.length - 1}
                moveDisabled={reordering || updateMutation.isPending}
              />
            ))
          )}
        </CardContent>
      </Card>

      <RuleDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconAlertTriangle className="size-5 text-destructive" />
              Delete this rule?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? summarize(deleteTarget) : ""} — transactions it already categorized keep
              their category.
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
