/**
 * Bulk-delete confirmation dialog for /transactions, two modes:
 *  - "selection": deletes specific transactionIds (multi-select floating bar
 *    "Delete" button) via delete-transactions-by-ids. Imported rows are
 *    deleted freely; Plaid-real rows need an explicit opt-in checkbox.
 *  - "filter": deletes everything matching the CURRENT filter bar (the "…"
 *    menu's "Delete imported matching filters…") via delete-transactions,
 *    always dryRun-previewed first, defaulting to imported-only. Requires
 *    typing DELETE to confirm when more than 100 rows would be removed.
 * Both paths always show the imported/Plaid breakdown before anything is
 * deleted, and never delete Plaid-real rows without explicit confirmation —
 * per AGENTS.md, prefer Ignore for real synced data since it can't be
 * re-imported.
 */
import { useActionMutation } from "@agent-native/core/client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TYPED_CONFIRM_THRESHOLD = 100;
const CONFIRM_WORD = "DELETE";

interface FilterDeleteArgs {
  accountIds?: string[];
  categoryIds?: string[];
  search?: string;
  searchScope?: "name" | "all";
  dateFrom?: string;
  dateTo?: string;
  datePreset?: "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear" | "lastYear";
  amount?: string;
  source?: "imported" | "plaid";
}

export function DeleteTransactionsDialog({
  open,
  onOpenChange,
  mode,
  transactionIds,
  filterArgs,
  filterSummary,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "selection" | "filter";
  /** Required for mode "selection". */
  transactionIds?: string[];
  /** Required for mode "filter" — same args passed to list-transactions. */
  filterArgs?: FilterDeleteArgs;
  /** Human-readable description of the active filters, for mode "filter". */
  filterSummary?: string;
  onDeleted?: () => void;
}) {
  const deleteByIdsMutation = useActionMutation("delete-transactions-by-ids");
  const deleteByFilterMutation = useActionMutation("delete-transactions");

  const [includePlaid, setIncludePlaid] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<{ total: number; imported: number; plaid: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIncludePlaid(false);
    setConfirmText("");
    setPreview(null);
  }, [open, mode]);

  // Filter mode: run a dryRun preview as soon as the dialog opens.
  useEffect(() => {
    if (!open || mode !== "filter" || !filterArgs) return;
    setPreviewLoading(true);
    deleteByFilterMutation.mutate(
      { ...filterArgs, onlyImported: !includePlaid, dryRun: true },
      {
        onSuccess: (result: { total: number; imported: number; plaid: number }) => {
          setPreview(result);
          setPreviewLoading(false);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not preview delete");
          setPreviewLoading(false);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, filterArgs, includePlaid]);

  const wouldDelete = preview ? (includePlaid ? preview.total : preview.imported) : 0;
  const needsTypedConfirm = mode === "filter" && wouldDelete > TYPED_CONFIRM_THRESHOLD;
  const typedConfirmOk = !needsTypedConfirm || confirmText.trim().toUpperCase() === CONFIRM_WORD;

  function close() {
    onOpenChange(false);
  }

  function runSelectionDelete() {
    if (!transactionIds || transactionIds.length === 0) return;
    deleteByIdsMutation.mutate(
      { transactionIds, confirmPlaidDelete: includePlaid },
      {
        onSuccess: (result: { deleted: number; skippedPlaid: number }) => {
          const parts = [`Deleted ${result.deleted} transaction${result.deleted === 1 ? "" : "s"}`];
          if (result.skippedPlaid > 0) {
            parts.push(`${result.skippedPlaid} Plaid row${result.skippedPlaid === 1 ? "" : "s"} skipped`);
          }
          toast.success(parts.join(" — "));
          onDeleted?.();
          close();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
      },
    );
  }

  function runFilterDelete() {
    if (!filterArgs) return;
    if (!typedConfirmOk) return;
    deleteByFilterMutation.mutate(
      { ...filterArgs, onlyImported: !includePlaid, dryRun: false, confirmDelete: true },
      {
        onSuccess: (result: { deleted?: number; plaidSkipped?: number }) => {
          const deleted = result.deleted ?? 0;
          const plaidSkipped = result.plaidSkipped ?? 0;
          const parts = [`Deleted ${deleted} transaction${deleted === 1 ? "" : "s"}`];
          if (plaidSkipped > 0) {
            parts.push(`${plaidSkipped} Plaid row${plaidSkipped === 1 ? "" : "s"} excluded`);
          }
          toast.success(parts.join(" — "));
          onDeleted?.();
          close();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
      },
    );
  }

  const isDeleting = deleteByIdsMutation.isPending || deleteByFilterMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete transactions</DialogTitle>
          <DialogDescription>
            {mode === "filter"
              ? filterSummary
                ? `Matching: ${filterSummary}. This deletes every matching row on the server — not just what's loaded on this page — in one action. Cannot be undone (imported rows can be re-imported from the original CSV; Plaid rows cannot).`
                : "This deletes every matching row on the server — not just what's loaded on this page — in one action. Cannot be undone (imported rows can be re-imported from the original CSV; Plaid rows cannot)."
              : "This cannot be undone. Imported rows can be re-imported from the original CSV; Plaid rows cannot."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1 text-sm">
          {mode === "filter" ? (
            previewLoading || !preview ? (
              <p className="text-muted-foreground">Checking matching transactions...</p>
            ) : (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="text-2xl font-semibold tabular-nums">
                  {preview.imported}
                  <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                    imported transaction{preview.imported === 1 ? "" : "s"} — full match count, not just this page
                  </span>
                </p>
                <p className="mt-1">
                  All {preview.imported} will be deleted server-side in one action.
                </p>
                {preview.plaid > 0 ? (
                  <p className="mt-1 text-muted-foreground">
                    {preview.plaid} Plaid row{preview.plaid === 1 ? "" : "s"} also match this filter and{" "}
                    {includePlaid ? "will be deleted too" : "are excluded by default (Plaid rows are never deleted unless you opt in below)"}.
                  </p>
                ) : null}
              </div>
            )
          ) : null}

          {mode === "selection" ? (
            <p className="text-muted-foreground">
              {transactionIds?.length ?? 0} transaction{(transactionIds?.length ?? 0) === 1 ? "" : "s"} selected.
              Imported rows will be deleted; Plaid rows are skipped unless you opt in below.
            </p>
          ) : null}

          <label className="flex items-start gap-2 rounded-lg border p-3">
            <Checkbox checked={includePlaid} onCheckedChange={(v) => setIncludePlaid(Boolean(v))} />
            <span>
              <span className="block font-medium">Also delete matching Plaid rows</span>
              <span className="block text-xs text-muted-foreground">
                Unusual — prefer Ignore for real synced data instead, since it can&apos;t be recovered by re-import.
              </span>
            </span>
          </label>

          {needsTypedConfirm ? (
            <div className="space-y-1.5">
              <Label htmlFor="delete-confirm-text">
                Type <strong>{CONFIRM_WORD}</strong> to confirm deleting {wouldDelete} rows
              </Label>
              <Input
                id="delete-confirm-text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoComplete="off"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={
              isDeleting ||
              !typedConfirmOk ||
              (mode === "filter" && (previewLoading || wouldDelete === 0)) ||
              (mode === "selection" && (transactionIds?.length ?? 0) === 0)
            }
            onClick={mode === "selection" ? runSelectionDelete : runFilterDelete}
          >
            Delete{mode === "filter" && preview ? ` ${wouldDelete}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
