/**
 * /categories — manage spending categories: icon/color/group, transaction
 * counts, create/edit, and delete-with-reassignment for custom categories.
 * System categories can only have icon/color customized (name/group are
 * fixed since PFC mapping and analytics key off the system name).
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { IconAlertTriangle, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { CategoryDialog, type CategoryFormValue } from "@/components/finance/CategoryDialog";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_TITLE } from "@/lib/app-config";
import { DEFAULT_CATEGORY_COLOR, iconForCategory } from "@/lib/category-icons";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Categories - ${APP_TITLE}` }];
}

interface CategoryRow {
  id: string;
  name: string;
  group: string;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
  profile: string;
  transactionCount: number;
}
interface ListCategoriesResult {
  categories: CategoryRow[];
  uncategorizedCount: number;
}

const GROUP_LABEL: Record<string, string> = {
  expenses: "Expenses",
  earnings: "Earnings",
  ignored: "Ignored",
};

function CategoryRowItem({
  category,
  onEdit,
  onDelete,
  onViewTransactions,
}: {
  category: CategoryRow;
  onEdit: () => void;
  onDelete: () => void;
  onViewTransactions: () => void;
}) {
  const Icon = iconForCategory(category.icon);
  const color = category.color ?? DEFAULT_CATEGORY_COLOR;
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/50">
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `${color}22` }}
      >
        <Icon className="size-4" style={{ color }} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{category.name}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
            {GROUP_LABEL[category.group] ?? category.group}
          </Badge>
          {category.isSystem ? (
            <Badge variant="secondary" className="hidden shrink-0 text-[10px] sm:inline-flex">
              System
            </Badge>
          ) : null}
          <button
            type="button"
            onClick={onViewTransactions}
            className="min-w-0 truncate text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
          >
            {category.transactionCount} transaction{category.transactionCount === 1 ? "" : "s"}
          </button>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      {!category.isSystem ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${category.name}`}
        >
          <IconTrash className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

export default function CategoriesRoute() {
  useSetPageTitle("Categories");
  const navigate = useNavigate();

  const listQuery = useActionQuery<ListCategoriesResult>("list-categories", {});
  const deleteMutation = useActionMutation("delete-category");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryFormValue | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CategoryRow | null>(null);
  const [replacementMode, setReplacementMode] = useState<"uncategorized" | "reassign">("uncategorized");
  const [replacementCategoryId, setReplacementCategoryId] = useState<string | null>(null);

  const categories = listQuery.data?.categories ?? [];
  const uncategorizedCount = listQuery.data?.uncategorizedCount ?? 0;

  const grouped = useMemo(() => {
    const order: Array<CategoryRow["group"]> = ["expenses", "earnings", "ignored"];
    return order
      .map((g) => ({ group: g, items: categories.filter((c) => c.group === g) }))
      .filter((g) => g.items.length > 0);
  }, [categories]);

  const otherCategories = deleteTarget ? categories.filter((c) => c.id !== deleteTarget.id) : [];

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(category: CategoryRow) {
    setEditing({
      id: category.id,
      name: category.name,
      group: category.group as CategoryFormValue["group"],
      icon: category.icon ?? "dots",
      color: category.color ?? DEFAULT_CATEGORY_COLOR,
      isSystem: category.isSystem,
    });
    setDialogOpen(true);
  }

  function openDelete(category: CategoryRow) {
    setDeleteTarget(category);
    setReplacementMode("uncategorized");
    setReplacementCategoryId(null);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      {
        id: deleteTarget.id,
        ...(replacementMode === "reassign" && replacementCategoryId
          ? { replacementCategoryId }
          : {}),
      },
      {
        onSuccess: (result: { reassignedCount: number }) => {
          toast.success(
            result.reassignedCount > 0
              ? `Deleted "${deleteTarget.name}" — ${result.reassignedCount} transaction${result.reassignedCount === 1 ? "" : "s"} ${replacementMode === "reassign" ? "reassigned" : "now uncategorized"}.`
              : `Deleted "${deleteTarget.name}"`,
          );
          setDeleteTarget(null);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete category"),
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Categories</h1>
          <p className="text-sm text-muted-foreground">
            Icons, colors, and groups for how transactions are organized.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <IconPlus className="size-4" />
          Add category
        </Button>
      </div>

      {uncategorizedCount > 0 ? (
        <Card className="rounded-2xl border-amber-500/30 bg-amber-500/5 shadow-sm">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2">
              <IconAlertTriangle className="size-5 text-amber-600 dark:text-amber-400" />
              <p className="text-sm">
                <strong>{uncategorizedCount}</strong> uncategorized transaction
                {uncategorizedCount === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/transactions?categoryId=uncategorized")}
              >
                View transactions
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/rules")}
              >
                Create rule
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {listQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        grouped.map(({ group, items }) => (
          <Card key={group} className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{GROUP_LABEL[group] ?? group}</CardTitle>
              <CardDescription>
                {group === "expenses"
                  ? "Counts as spending in analytics."
                  : group === "earnings"
                    ? "Counts as income in analytics."
                    : "Excluded from spend & income (transfers, loan payments)."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 p-3 pt-0">
              {items.map((c) => (
                <CategoryRowItem
                  key={c.id}
                  category={c}
                  onEdit={() => openEdit(c)}
                  onDelete={() => openDelete(c)}
                  onViewTransactions={() => navigate(`/transactions?categoryId=${encodeURIComponent(c.id)}`)}
                />
              ))}
            </CardContent>
          </Card>
        ))
      )}

      <CategoryDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IconAlertTriangle className="size-5 text-destructive" />
              Delete &quot;{deleteTarget?.name}&quot;?
            </DialogTitle>
            <DialogDescription>
              {deleteTarget && deleteTarget.transactionCount > 0
                ? `${deleteTarget.transactionCount} transaction${deleteTarget.transactionCount === 1 ? "" : "s"} use this category.`
                : "No transactions use this category."}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && deleteTarget.transactionCount > 0 ? (
            <RadioGroup value={replacementMode} onValueChange={(v) => setReplacementMode(v as typeof replacementMode)}>
              <label
                htmlFor="delete-mode-uncategorized"
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-3",
                  replacementMode === "uncategorized" && "border-primary",
                )}
              >
                <RadioGroupItem value="uncategorized" id="delete-mode-uncategorized" className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Leave uncategorized</p>
                  <p className="text-xs text-muted-foreground">
                    These transactions will show up as uncategorized.
                  </p>
                </div>
              </label>
              <label
                htmlFor="delete-mode-reassign"
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-3",
                  replacementMode === "reassign" && "border-primary",
                )}
              >
                <RadioGroupItem value="reassign" id="delete-mode-reassign" className="mt-0.5" />
                <div className="flex-1 space-y-2">
                  <p className="text-sm font-medium">Reassign to another category</p>
                  <Select
                    value={replacementCategoryId ?? undefined}
                    onValueChange={setReplacementCategoryId}
                  >
                    <SelectTrigger
                      className="h-8 w-full text-xs"
                      onClick={() => setReplacementMode("reassign")}
                    >
                      <SelectValue placeholder="Choose a category..." />
                    </SelectTrigger>
                    <SelectContent>
                      {otherCategories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </label>
            </RadioGroup>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                deleteMutation.isPending ||
                (replacementMode === "reassign" && !replacementCategoryId)
              }
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
