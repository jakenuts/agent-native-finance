/**
 * Compact right-side Sheet showing full transaction detail (Rocket Money
 * reference, but intentionally NOT a huge modal). Rendered from the row
 * chevron on /transactions and the dashboard "Recent transactions" list.
 *
 * Parity: every control here (rename, note, tax-deductible, ignore, add
 * rule) calls the same actions the agent can call directly
 * (update-transaction, create-rule, apply-rules).
 */
import { callAction, useActionMutation, useActionQuery } from "@agent-native/core/client";
import { IconEdit, IconExternalLink, IconReceipt } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { CategoryChip } from "@/components/finance/CategoryChip";
import { MerchantAvatar } from "@/components/finance/MerchantAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatMoney } from "@/lib/finance-format";

interface TransactionDetailData {
  id: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amount: number;
  pending: boolean;
  categoryId: string | null;
  category: string | null;
  note: string | null;
  isIgnored: boolean;
  isTaxDeductible: boolean;
  recurringId: string | null;
  recurringName: string | null;
  accountName: string | null;
  accountMask: string | null;
  accountType: string | null;
  institutionName: string | null;
  rawName: string | null;
}

interface MerchantHistoryRow {
  id: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amount: number;
}
interface MerchantHistoryResult {
  merchantKey: string;
  count: number;
  total: number;
  rows: MerchantHistoryRow[];
}

/** Debounce a callback by `delayMs`; safe to call on every keystroke. */
function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (...args: Args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fnRef.current(...args), delayMs);
  };
}

export function TransactionDetail({
  transactionId,
  open,
  onOpenChange,
  onAddRule,
}: {
  transactionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the rules dialog prefilled from this transaction (see rules.tsx / RuleDialog). */
  onAddRule?: (prefill: { matchName: string; setCategoryId: string | null }) => void;
}) {
  const navigate = useNavigate();
  const detailQuery = useActionQuery<TransactionDetailData>(
    "get-transaction",
    { id: transactionId ?? "" },
    { enabled: open && Boolean(transactionId) },
  );
  const updateMutation = useActionMutation("update-transaction");

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaved, setNoteSaved] = useState(true);

  const [history, setHistory] = useState<MerchantHistoryResult | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const data = detailQuery.data;

  useEffect(() => {
    if (data) {
      setNoteDraft(data.note ?? "");
      setNoteSaved(true);
    }
  }, [data?.id, data?.note]);

  useEffect(() => {
    if (!open || !transactionId) {
      setHistory(null);
      return;
    }
    setHistoryLoading(true);
    callAction<MerchantHistoryResult>(
      "merchant-history",
      { transactionId, limit: 8 },
      { method: "GET" },
    )
      .then(setHistory)
      .catch(() => setHistory(null))
      .finally(() => setHistoryLoading(false));
  }, [open, transactionId]);

  const debouncedSaveNote = useDebouncedCallback((value: string) => {
    if (!transactionId) return;
    updateMutation.mutate(
      { id: transactionId, note: value },
      {
        onSuccess: () => setNoteSaved(true),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save note"),
      },
    );
  }, 600);

  function handleNoteChange(value: string) {
    setNoteDraft(value);
    setNoteSaved(false);
    debouncedSaveNote(value);
  }

  function startEditName() {
    if (!data) return;
    setNameDraft(data.merchantName || data.name || "");
    setEditingName(true);
  }

  function saveName() {
    if (!transactionId) return;
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!trimmed || trimmed === (data?.merchantName || data?.name)) return;
    updateMutation.mutate(
      { id: transactionId, merchantName: trimmed },
      {
        onSuccess: () => toast.success("Renamed"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not rename"),
      },
    );
  }

  function toggleFlag(field: "isTaxDeductible" | "isIgnored", next: boolean) {
    if (!transactionId) return;
    updateMutation.mutate(
      { id: transactionId, [field]: next },
      {
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
      },
    );
  }

  function handleAddRule() {
    if (!data) return;
    const matchName = (data.merchantName || data.rawName || "").trim();
    onAddRule?.({ matchName, setCategoryId: data.categoryId });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {!data ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {detailQuery.isLoading ? "Loading..." : "Select a transaction."}
          </div>
        ) : (
          <>
            <SheetHeader className="space-y-3 text-left">
              <div className="flex items-center gap-3">
                <MerchantAvatar name={data.merchantName || data.name} size="lg" />
                <div className="min-w-0 flex-1">
                  {editingName ? (
                    <Input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={saveName}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveName();
                        if (e.key === "Escape") setEditingName(false);
                      }}
                      className="h-8"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={startEditName}
                      className="group flex items-center gap-1.5 text-left"
                    >
                      <SheetTitle className="truncate text-base">
                        {data.merchantName || data.name || "Unknown"}
                      </SheetTitle>
                      <IconEdit className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  )}
                  <SheetDescription className="flex items-center gap-2">
                    {formatDate(data.date)}
                    {data.pending ? (
                      <Badge variant="secondary" className="text-[10px]">
                        Pending
                      </Badge>
                    ) : null}
                  </SheetDescription>
                </div>
              </div>

              <p
                className={
                  data.amount < 0
                    ? "text-3xl font-semibold tabular-nums text-fin-positive"
                    : "text-3xl font-semibold tabular-nums"
                }
              >
                {data.amount < 0 ? "+" : "-"}
                {formatMoney(Math.abs(data.amount))}
              </p>

              <div>
                <CategoryChip
                  transactionId={data.id}
                  categoryId={data.categoryId}
                  categoryName={data.category}
                />
              </div>
            </SheetHeader>

            <div className="mt-6 space-y-6">
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Note</label>
                  <span className="text-[10px] text-muted-foreground">
                    {noteSaved ? (noteDraft ? "Saved" : "") : "Saving..."}
                  </span>
                </div>
                <Textarea
                  value={noteDraft}
                  onChange={(e) => handleNoteChange(e.target.value)}
                  placeholder="Add a note (e.g. 'split with Sam', 'reimbursable')"
                  rows={2}
                  className="resize-none text-sm"
                />
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Tax deductible</span>
                  <Switch
                    checked={data.isTaxDeductible}
                    onCheckedChange={(v) => toggleFlag("isTaxDeductible", v)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Ignore (exclude from analytics)</span>
                  <Switch
                    checked={data.isIgnored}
                    onCheckedChange={(v) => toggleFlag("isIgnored", v)}
                  />
                </div>
              </div>

              {data.recurringName ? (
                <button
                  type="button"
                  onClick={() => navigate(`/recurring?recurringId=${data.recurringId}`)}
                  className="flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent/50"
                >
                  <span className="flex items-center gap-2">
                    <IconReceipt className="size-4 text-muted-foreground" />
                    Linked to recurring: <strong>{data.recurringName}</strong>
                  </span>
                  <IconExternalLink className="size-3.5 text-muted-foreground" />
                </button>
              ) : null}

              <Button variant="outline" size="sm" className="w-full" onClick={handleAddRule}>
                Add rule from this transaction
              </Button>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-muted-foreground">Merchant history</h3>
                  {history ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {history.count} txn{history.count === 1 ? "" : "s"} ·{" "}
                        {formatMoney(Math.abs(history.total))} total
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const name = (data.merchantName || data.name || "").trim();
                          if (!name) return;
                          navigate(`/spending?merchant=${encodeURIComponent(name)}`);
                        }}
                        className="flex items-center gap-0.5 text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
                      >
                        View spending
                        <IconExternalLink className="size-3" />
                      </button>
                    </div>
                  ) : null}
                </div>
                {historyLoading ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">Loading...</p>
                ) : !history || history.rows.length <= 1 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    No other transactions from this merchant yet.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-lg border">
                    {history.rows
                      .filter((r) => r.id !== data.id)
                      .slice(0, 6)
                      .map((r) => (
                        <div
                          key={r.id}
                          className="flex items-center justify-between px-3 py-2 text-xs"
                        >
                          <span className="text-muted-foreground">{formatDate(r.date)}</span>
                          <span
                            className={
                              r.amount < 0
                                ? "font-medium tabular-nums text-fin-positive"
                                : "font-medium tabular-nums"
                            }
                          >
                            {r.amount < 0 ? "+" : "-"}
                            {formatMoney(Math.abs(r.amount))}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              <div className="space-y-1 border-t pt-4 text-xs text-muted-foreground">
                <p>
                  {data.accountName ?? "Account"}
                  {data.accountMask ? ` ••${data.accountMask}` : ""}
                  {data.institutionName ? ` · ${data.institutionName}` : ""}
                </p>
                <p className="break-words font-mono">{data.rawName}</p>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

