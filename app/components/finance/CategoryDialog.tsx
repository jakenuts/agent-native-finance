/**
 * Create/edit dialog for spending categories. System categories can only have
 * their icon/color edited (name/group are fixed since analytics and PFC
 * mapping key off the system name); custom categories are fully editable.
 * Shared by /categories.
 */
import { useActionMutation } from "@agent-native/core/client";
import { IconCheck } from "@tabler/icons-react";
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
import { CATEGORY_ICON_CHOICES, iconForCategory } from "@/lib/category-icons";
import { cn } from "@/lib/utils";

export interface CategoryFormValue {
  id?: string;
  name: string;
  group: "expenses" | "earnings" | "ignored";
  icon: string;
  color: string;
  isSystem: boolean;
}

const PALETTE = [
  "#4ade80",
  "#f97316",
  "#60a5fa",
  "#c084fc",
  "#f472b6",
  "#facc15",
  "#ef4444",
  "#2dd4bf",
  "#818cf8",
  "#22c55e",
  "#94a3b8",
  "#a8a29e",
];

const EMPTY_CATEGORY: CategoryFormValue = {
  name: "",
  group: "expenses",
  icon: "dots",
  color: PALETTE[0],
  isSystem: false,
};

export function CategoryDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing category to edit (omit for create). */
  editing?: CategoryFormValue | null;
}) {
  const [form, setForm] = useState<CategoryFormValue>(EMPTY_CATEGORY);
  const createMutation = useActionMutation("create-category");
  const updateMutation = useActionMutation("update-category");

  useEffect(() => {
    if (!open) return;
    setForm(editing ?? EMPTY_CATEGORY);
  }, [open, editing]);

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isSystem = form.isSystem;

  function close() {
    onOpenChange(false);
  }

  function save() {
    if (!isSystem && !form.name.trim()) {
      toast.error("Name is required.");
      return;
    }

    if (form.id) {
      const payload = isSystem
        ? { id: form.id, icon: form.icon, color: form.color }
        : { id: form.id, name: form.name.trim(), group: form.group, icon: form.icon, color: form.color };
      updateMutation.mutate(payload, {
        onSuccess: () => {
          toast.success("Category updated");
          close();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update category"),
      });
    } else {
      createMutation.mutate(
        { name: form.name.trim(), group: form.group, icon: form.icon, color: form.color },
        {
          onSuccess: () => {
            toast.success("Category created");
            close();
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create category"),
        },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit category" : "Create category"}</DialogTitle>
          <DialogDescription>
            {isSystem
              ? "System categories keep their name and group — you can still customize the icon and color."
              : "Custom categories can be fully edited or deleted later."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              value={form.name}
              disabled={isSystem}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Pets"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Group</Label>
            <Select
              value={form.group}
              disabled={isSystem}
              onValueChange={(v) => setForm((f) => ({ ...f, group: v as CategoryFormValue["group"] }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expenses">Expenses</SelectItem>
                <SelectItem value="earnings">Earnings</SelectItem>
                <SelectItem value="ignored">Ignored (transfers, etc.)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Icon</Label>
            <div className="grid grid-cols-8 gap-1.5">
              {CATEGORY_ICON_CHOICES.map((slug) => {
                const Icon = iconForCategory(slug);
                const active = form.icon === slug;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, icon: slug }))}
                    aria-label={slug}
                    aria-pressed={active}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-md border transition-colors hover:bg-accent",
                      active ? "border-primary bg-accent" : "border-transparent",
                    )}
                  >
                    <Icon className="size-4" style={{ color: form.color }} />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((hex) => {
                const active = form.color.toLowerCase() === hex.toLowerCase();
                return (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, color: hex }))}
                    aria-label={hex}
                    aria-pressed={active}
                    className="flex size-7 items-center justify-center rounded-full border"
                    style={{ backgroundColor: hex, borderColor: active ? "var(--foreground)" : "transparent" }}
                  >
                    {active ? <IconCheck className="size-3.5 text-white" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={save} disabled={isSaving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
