/**
 * Create/edit dialog for auto-categorization rules, with a live "matches N
 * transactions" preview powered by apply-rules' inline-rule dryRun mode
 * (no need to save the rule first to see its impact). Shared by /rules and
 * the "Add rule from this transaction" flow in TransactionDetail.
 */
import { callAction, useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { iconForCategory } from "@/lib/category-icons";

export interface RulePrefill {
  matchName: string;
  setCategoryId: string | null;
}

export interface RuleFormValue {
  id?: string;
  matchName: string;
  matchNameMode: "contains" | "exact" | "regex";
  matchNameExclude: string;
  matchAccountId: string;
  matchMinDollars: string;
  matchMaxDollars: string;
  setCategoryId: string;
  setMerchantName: string;
  priority: number;
}

const EMPTY_RULE: RuleFormValue = {
  matchName: "",
  matchNameMode: "contains",
  matchNameExclude: "",
  matchAccountId: "none",
  matchMinDollars: "",
  matchMaxDollars: "",
  setCategoryId: "none",
  setMerchantName: "",
  priority: 100,
};

/** True when a regex-mode pattern fails to compile (mirrors server-side validation). */
function isInvalidRegexPattern(mode: string, pattern: string): boolean {
  if (mode !== "regex" || !pattern.trim()) return false;
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return false;
  } catch {
    return true;
  }
}

interface CategoryOption {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}
interface ListCategoriesResult {
  categories: CategoryOption[];
}
interface AccountOption {
  id: string;
  label: string;
}
interface ListAccountsResult {
  id: string;
  name: string;
  accounts: Array<{ id: string; name: string | null; type: string | null; mask: string | null }>;
}

function toCents(dollars: string): number | undefined {
  const n = Number(dollars);
  if (!dollars.trim() || Number.isNaN(n)) return undefined;
  return Math.round(n * 100);
}

export function RuleDialog({
  open,
  onOpenChange,
  editing,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing rule to edit (omit for create). */
  editing?: RuleFormValue | null;
  /** Prefill values when opened from "Add rule from this transaction". */
  prefill?: RulePrefill | null;
  onSaved?: () => void;
}) {
  const [form, setForm] = useState<RuleFormValue>(EMPTY_RULE);
  const [preview, setPreview] = useState<{ matchedCount: number; changedCount: number } | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [savedRuleId, setSavedRuleId] = useState<string | null>(null);

  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {});
  const accountsQuery = useActionQuery<ListAccountsResult[]>("list-accounts", {});
  const createMutation = useActionMutation("create-rule");
  const updateMutation = useActionMutation("update-rule");
  const applyMutation = useActionMutation("apply-rules");

  const accountOptions: AccountOption[] = (accountsQuery.data ?? []).flatMap((inst) =>
    inst.accounts.map((a) => ({
      id: a.id,
      label: `${inst.name} · ${a.name ?? a.type ?? "Account"}`,
    })),
  );

  useEffect(() => {
    if (!open) return;
    setConfirmApply(false);
    setSavedRuleId(null);
    setPreview(null);
    if (editing) {
      setForm(editing);
    } else if (prefill) {
      setForm({ ...EMPTY_RULE, matchName: prefill.matchName, setCategoryId: prefill.setCategoryId ?? "none" });
    } else {
      setForm(EMPTY_RULE);
    }
  }, [open, editing, prefill]);

  const patternInvalid = isInvalidRegexPattern(form.matchNameMode, form.matchName);

  // Live preview: debounce-free but only fires when there's enough to match.
  useEffect(() => {
    if (!open) return;
    const hasMatch =
      form.matchName.trim() ||
      form.matchAccountId !== "none" ||
      form.matchMinDollars.trim() ||
      form.matchMaxDollars.trim();
    const hasEffect = form.setCategoryId !== "none" || form.setMerchantName.trim();
    if (!hasMatch || !hasEffect || patternInvalid) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      callAction<{ matchedCount: number; changedCount: number }>(
        "apply-rules",
        {
          dryRun: true,
          rule: {
            matchName: form.matchName.trim() || undefined,
            matchNameMode: form.matchNameMode,
            matchNameExclude: form.matchNameExclude.trim() || undefined,
            matchAccountId: form.matchAccountId === "none" ? undefined : form.matchAccountId,
            matchMinCents: toCents(form.matchMinDollars),
            matchMaxCents: toCents(form.matchMaxDollars),
            setCategoryId: form.setCategoryId === "none" ? undefined : form.setCategoryId,
            setMerchantName: form.setMerchantName.trim() || undefined,
          },
        },
        { method: "POST" },
      )
        .then((res) => setPreview({ matchedCount: res.matchedCount, changedCount: res.changedCount }))
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [
    open,
    form.matchName,
    form.matchNameMode,
    form.matchNameExclude,
    form.matchAccountId,
    form.matchMinDollars,
    form.matchMaxDollars,
    form.setCategoryId,
    form.setMerchantName,
    patternInvalid,
  ]);

  function close() {
    onOpenChange(false);
  }

  function save() {
    const hasMatch =
      form.matchName.trim() ||
      form.matchAccountId !== "none" ||
      form.matchMinDollars.trim() ||
      form.matchMaxDollars.trim();
    const hasEffect = form.setCategoryId !== "none" || form.setMerchantName.trim();
    if (!hasMatch) {
      toast.error("Add at least one match condition.");
      return;
    }
    if (!hasEffect) {
      toast.error("Add at least one effect (category or rename).");
      return;
    }
    if (patternInvalid) {
      toast.error("That regex pattern doesn't compile — fix it before saving.");
      return;
    }

    const payload = {
      matchName: form.matchName.trim() || undefined,
      matchNameMode: form.matchNameMode,
      matchNameExclude: form.matchNameExclude.trim() || undefined,
      matchAccountId: form.matchAccountId === "none" ? undefined : form.matchAccountId,
      matchMinCents: toCents(form.matchMinDollars),
      matchMaxCents: toCents(form.matchMaxDollars),
      setCategoryId: form.setCategoryId === "none" ? undefined : form.setCategoryId,
      setMerchantName: form.setMerchantName.trim() || undefined,
      priority: form.priority,
    };

    if (form.id) {
      updateMutation.mutate(
        { id: form.id, ...payload },
        {
          onSuccess: () => {
            toast.success("Rule updated");
            setSavedRuleId(form.id!);
            setConfirmApply(true);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update rule"),
        },
      );
    } else {
      createMutation.mutate(payload, {
        onSuccess: (res: unknown) => {
          const id = (res as { id?: string })?.id;
          toast.success("Rule created");
          if (id) {
            setSavedRuleId(id);
            setConfirmApply(true);
          } else {
            close();
          }
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create rule"),
      });
    }
  }

  function applyNow() {
    if (!savedRuleId) return;
    applyMutation.mutate(
      { ruleId: savedRuleId, dryRun: false },
      {
        onSuccess: (res: unknown) => {
          const changed = (res as { changedCount?: number })?.changedCount ?? 0;
          toast.success(`Applied to ${changed} transaction${changed === 1 ? "" : "s"}`);
          onSaved?.();
          close();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not apply rule"),
      },
    );
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-lg">
        {confirmApply ? (
          <>
            <DialogHeader>
              <DialogTitle>Apply to existing transactions?</DialogTitle>
              <DialogDescription>
                This rule matches {preview?.matchedCount ?? 0} transaction
                {(preview?.matchedCount ?? 0) === 1 ? "" : "s"}, of which {preview?.changedCount ?? 0}{" "}
                would actually change. New transactions will use this rule automatically either way.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onSaved?.();
                  close();
                }}
              >
                Not now
              </Button>
              <Button onClick={applyNow} disabled={applyMutation.isPending}>
                Apply to {preview?.changedCount ?? 0} now
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{form.id ? "Edit rule" : "Create rule"}</DialogTitle>
              <DialogDescription>
                Match transactions by name, account, and/or amount, then set a category and/or rename.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="rule-match-name">
                    {form.matchNameMode === "regex" ? "Name matches (regex)" : "Name contains/is"}
                  </Label>
                  <Input
                    id="rule-match-name"
                    value={form.matchName}
                    onChange={(e) => setForm((f) => ({ ...f, matchName: e.target.value }))}
                    placeholder={form.matchNameMode === "regex" ? "e.g. chevron|renner|shell" : "e.g. starbucks"}
                    aria-invalid={patternInvalid}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Mode</Label>
                  <Select
                    value={form.matchNameMode}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, matchNameMode: v as "contains" | "exact" | "regex" }))
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contains">Contains</SelectItem>
                      <SelectItem value="exact">Exact</SelectItem>
                      <SelectItem value="regex">Regex</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.matchNameMode === "regex" ? (
                <p className={"-mt-2 text-xs " + (patternInvalid ? "text-destructive" : "text-muted-foreground")}>
                  {patternInvalid
                    ? "This pattern doesn't compile as a regular expression."
                    : "Case-insensitive regular expression, e.g. chevron|renner|shell for gas stations."}
                </p>
              ) : null}

              <div className="grid gap-1.5">
                <Label htmlFor="rule-match-exclude">But not containing (optional)</Label>
                <Input
                  id="rule-match-exclude"
                  value={form.matchNameExclude}
                  onChange={(e) => setForm((f) => ({ ...f, matchNameExclude: e.target.value }))}
                  placeholder="e.g. Protection"
                />
              </div>

              <div className="grid gap-1.5">
                <Label>Account (optional)</Label>
                <Select
                  value={form.matchAccountId}
                  onValueChange={(v) => setForm((f) => ({ ...f, matchAccountId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any account</SelectItem>
                    {accountOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="rule-min">Min amount ($, optional)</Label>
                  <Input
                    id="rule-min"
                    type="number"
                    step="0.01"
                    value={form.matchMinDollars}
                    onChange={(e) => setForm((f) => ({ ...f, matchMinDollars: e.target.value }))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="rule-max">Max amount ($, optional)</Label>
                  <Input
                    id="rule-max"
                    type="number"
                    step="0.01"
                    value={form.matchMaxDollars}
                    onChange={(e) => setForm((f) => ({ ...f, matchMaxDollars: e.target.value }))}
                  />
                </div>
              </div>

              <div className="border-t pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Then apply</p>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label>Set category</Label>
                    <Select
                      value={form.setCategoryId}
                      onValueChange={(v) => setForm((f) => ({ ...f, setCategoryId: v }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No change</SelectItem>
                        {(categoriesQuery.data?.categories ?? []).map((c) => {
                          const Icon = iconForCategory(c.icon);
                          return (
                            <SelectItem key={c.id} value={c.id}>
                              <span className="flex items-center gap-2">
                                <Icon className="size-3.5" style={{ color: c.color ?? undefined }} />
                                {c.name}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="rule-rename">Rename merchant to (optional)</Label>
                    <Input
                      id="rule-rename"
                      value={form.setMerchantName}
                      onChange={(e) => setForm((f) => ({ ...f, setMerchantName: e.target.value }))}
                      placeholder="e.g. Starbucks"
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                {previewLoading ? (
                  <span className="text-muted-foreground">Checking matches...</span>
                ) : preview ? (
                  <span>
                    Matches <strong>{preview.matchedCount}</strong> transaction
                    {preview.matchedCount === 1 ? "" : "s"} ({preview.changedCount} would change)
                  </span>
                ) : (
                  <span className="text-muted-foreground">Add a match condition to preview impact.</span>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={save} disabled={isSaving || patternInvalid}>
                Save
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
