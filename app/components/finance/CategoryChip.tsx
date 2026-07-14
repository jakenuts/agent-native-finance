/**
 * Small colored, clickable category chip used on transaction rows (dashboard
 * "Recent transactions" and the /transactions list). Clicking opens a
 * popover with a searchable category list; picking one calls
 * set-transaction-category and relies on the framework's automatic
 * ["action"] query invalidation to refresh every list showing this row.
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DEFAULT_CATEGORY_COLOR, iconForCategory } from "@/lib/category-icons";
import { cn } from "@/lib/utils";

interface CategoryOption {
  id: string;
  name: string;
  group: string;
  icon: string | null;
  color: string | null;
}

interface ListCategoriesResult {
  categories: CategoryOption[];
  uncategorizedCount: number;
}

export function CategoryChip({
  transactionId,
  categoryId,
  categoryName,
  className,
}: {
  transactionId: string;
  categoryId: string | null;
  categoryName: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {}, {
    enabled: open,
  });
  const setCategory = useActionMutation("set-transaction-category");

  const current = categoriesQuery.data?.categories.find((c) => c.id === categoryId);
  const color = current?.color ?? DEFAULT_CATEGORY_COLOR;
  const label = categoryName ?? current?.name ?? "Uncategorized";
  const Icon = iconForCategory(current?.icon);

  function pick(nextId: string | null) {
    setOpen(false);
    if (nextId === categoryId) return;
    setCategory.mutate(
      { transactionId, categoryId: nextId, lock: true },
      {
        onSuccess: () => {
          const nextName =
            nextId == null
              ? "Uncategorized"
              : (categoriesQuery.data?.categories.find((c) => c.id === nextId)?.name ?? "category");
          toast.success(`Set category to ${nextName}`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not update category");
        },
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-transparent bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground transition-colors hover:border-border hover:bg-accent",
            className,
          )}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="truncate">{label}</span>
          <IconChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Set category..." />
          <CommandList>
            <CommandEmpty>No categories found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="Uncategorized" onSelect={() => pick(null)}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: DEFAULT_CATEGORY_COLOR }}
                />
                <span className="flex-1 truncate">Uncategorized</span>
                {categoryId == null ? <IconCheck className="size-4 shrink-0" /> : null}
              </CommandItem>
              {(categoriesQuery.data?.categories ?? []).map((c) => {
                const ItemIcon = iconForCategory(c.icon);
                return (
                  <CommandItem key={c.id} value={c.name} onSelect={() => pick(c.id)}>
                    <ItemIcon
                      className="size-4 shrink-0"
                      style={{ color: c.color ?? DEFAULT_CATEGORY_COLOR }}
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                    {categoryId === c.id ? <IconCheck className="size-4 shrink-0" /> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
