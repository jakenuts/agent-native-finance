/**
 * Rocket Money-style filters for /transactions. Desktop renders the chip bar
 * (Dates, Categories, Accounts, Amounts popovers) via TransactionFilterBar;
 * mobile renders a single "Filters" button that opens the bottom
 * TransactionFiltersSheet with every control stacked full-width. All state
 * lives in the parent (reflected to URL search params) so the agent can
 * drive filtered views via `navigate` with query params.
 */
import { IconCheck, IconChevronDown, IconCopy, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { MerchantAvatar } from "@/components/finance/MerchantAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DEFAULT_CATEGORY_COLOR, iconForCategory } from "@/lib/category-icons";
import { formatMoney } from "@/lib/finance-format";
import { cn } from "@/lib/utils";

export type DatePreset =
  | "last7"
  | "last30"
  | "last90"
  | "thisMonth"
  | "lastMonth"
  | "thisYear"
  | "lastYear"
  | "all"
  | "custom";

const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  last7: "Last 7 days",
  last30: "Last 30 days",
  last90: "Last 90 days",
  thisMonth: "This month",
  lastMonth: "Last month",
  thisYear: "This year",
  lastYear: "Last year",
  all: "All dates",
  custom: "Custom range",
};

export interface AmountFilter {
  op: "exactly" | "between" | "gt" | "lt";
  value: string;
  value2: string;
}

export interface CategoryOption {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}
export interface AccountOption {
  id: string;
  label: string;
  institutionName: string;
  mask: string | null;
}

export type SourceFilter = "all" | "imported" | "plaid";

export interface TransactionFiltersState {
  datePreset: DatePreset;
  dateFrom: string;
  dateTo: string;
  categoryIds: string[];
  accountIds: string[];
  amount: AmountFilter | null;
  source: SourceFilter;
}

export const EMPTY_FILTERS: TransactionFiltersState = {
  datePreset: "all",
  dateFrom: "",
  dateTo: "",
  categoryIds: [],
  accountIds: [],
  amount: null,
  source: "all",
};

const SOURCE_LABEL: Record<SourceFilter, string> = {
  all: "All",
  imported: "Imported",
  plaid: "Plaid",
};

function SourcePopover({
  value,
  onChange,
}: {
  value: SourceFilter;
  onChange: (next: SourceFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value !== "all";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={active ? "secondary" : "outline"} size="sm" className="gap-1.5">
          Source
          {active ? (
            <Badge variant="outline" className="ml-0.5 text-[10px]">
              {SOURCE_LABEL[value]}
            </Badge>
          ) : null}
          <IconChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="grid gap-1">
          {(["all", "imported", "plaid"] as SourceFilter[]).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className={cn(
                "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                value === opt && "bg-accent",
              )}
            >
              {SOURCE_LABEL[opt]}
              {value === opt ? <IconCheck className="size-4" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DatesPopover({
  value,
  onChange,
}: {
  value: TransactionFiltersState;
  onChange: (next: Partial<TransactionFiltersState>) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value.datePreset !== "all";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={active ? "secondary" : "outline"} size="sm" className="gap-1.5">
          Dates
          {active ? (
            <Badge variant="outline" className="ml-0.5 text-[10px]">
              {value.datePreset === "custom" ? "Custom" : DATE_PRESET_LABEL[value.datePreset]}
            </Badge>
          ) : null}
          <IconChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <div className="grid gap-1">
          {(
            [
              "last7",
              "last30",
              "last90",
              "thisMonth",
              "lastMonth",
              "thisYear",
              "lastYear",
              "all",
            ] as DatePreset[]
          ).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                onChange({ datePreset: preset, dateFrom: "", dateTo: "" });
                setOpen(false);
              }}
              className={cn(
                "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                value.datePreset === preset && "bg-accent",
              )}
            >
              {DATE_PRESET_LABEL[preset]}
              {value.datePreset === preset ? <IconCheck className="size-4" /> : null}
            </button>
          ))}
          <div className="mt-1 border-t pt-2">
            <p className="mb-1.5 px-2 text-xs font-medium text-muted-foreground">Custom range</p>
            <div className="grid grid-cols-2 gap-2 px-2">
              <Input
                type="date"
                value={value.dateFrom}
                onChange={(e) => onChange({ datePreset: "custom", dateFrom: e.target.value })}
                className="h-8 text-xs"
              />
              <Input
                type="date"
                value={value.dateTo}
                onChange={(e) => onChange({ datePreset: "custom", dateTo: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CategoriesPopover({
  categories,
  value,
  onChange,
}: {
  categories: CategoryOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={value.length ? "secondary" : "outline"} size="sm" className="gap-1.5">
          Categories
          {value.length ? (
            <Badge variant="outline" className="ml-0.5 text-[10px]">
              {value.length}
            </Badge>
          ) : null}
          <IconChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search categories..." />
          <CommandList>
            <CommandEmpty>No categories found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="Uncategorized" onSelect={() => toggle("uncategorized")}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: DEFAULT_CATEGORY_COLOR }}
                />
                <span className="flex-1 truncate">Uncategorized</span>
                {value.includes("uncategorized") ? <IconCheck className="size-4 shrink-0" /> : null}
              </CommandItem>
              {categories.map((c) => {
                const Icon = iconForCategory(c.icon);
                return (
                  <CommandItem key={c.id} value={c.name} onSelect={() => toggle(c.id)}>
                    <Icon className="size-4 shrink-0" style={{ color: c.color ?? DEFAULT_CATEGORY_COLOR }} />
                    <span className="flex-1 truncate">{c.name}</span>
                    {value.includes(c.id) ? <IconCheck className="size-4 shrink-0" /> : null}
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

function AccountsPopover({
  accounts,
  value,
  onChange,
}: {
  accounts: AccountOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={value.length ? "secondary" : "outline"} size="sm" className="gap-1.5">
          Accounts
          {value.length ? (
            <Badge variant="outline" className="ml-0.5 text-[10px]">
              {value.length}
            </Badge>
          ) : null}
          <IconChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search accounts..." />
          <CommandList>
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup>
              {accounts.map((a) => (
                <CommandItem key={a.id} value={a.label} onSelect={() => toggle(a.id)}>
                  <MerchantAvatar name={a.institutionName} size="sm" />
                  <span className="flex-1 truncate">{a.label}</span>
                  {value.includes(a.id) ? <IconCheck className="size-4 shrink-0" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AmountsPopover({
  value,
  onChange,
}: {
  value: AmountFilter | null;
  onChange: (next: AmountFilter | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AmountFilter>(
    value ?? { op: "exactly", value: "", value2: "" },
  );

  function apply() {
    if (!draft.value.trim()) {
      onChange(null);
      setOpen(false);
      return;
    }
    onChange(draft);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(value ?? { op: "exactly", value: "", value2: "" });
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={value ? "secondary" : "outline"} size="sm" className="gap-1.5">
          Amounts
          <IconChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="grid gap-3">
          <Select
            value={draft.op}
            onValueChange={(v) => setDraft((d) => ({ ...d, op: v as AmountFilter["op"] }))}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exactly">Exactly</SelectItem>
              <SelectItem value="between">Between</SelectItem>
              <SelectItem value="gt">Greater than</SelectItem>
              <SelectItem value="lt">Less than</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              step="0.01"
              value={draft.value}
              onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
              className="h-8"
              placeholder="0.00"
            />
            {draft.op === "between" ? (
              <>
                <span className="text-xs text-muted-foreground">and</span>
                <Input
                  type="number"
                  step="0.01"
                  value={draft.value2}
                  onChange={(e) => setDraft((d) => ({ ...d, value2: e.target.value }))}
                  className="h-8"
                  placeholder="0.00"
                />
              </>
            ) : null}
          </div>
          <Button size="sm" onClick={apply}>
            Set
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** True when any filter dimension (not search) is set. */
export function hasActiveFilterDimensions(filters: TransactionFiltersState): boolean {
  return (
    filters.datePreset !== "all" ||
    filters.categoryIds.length > 0 ||
    filters.accountIds.length > 0 ||
    filters.amount !== null ||
    filters.source !== "all"
  );
}

/** Count of active filter dimensions, shown in the mobile Filters button badge. */
export function countActiveFilters(filters: TransactionFiltersState): number {
  return (
    (filters.datePreset !== "all" ? 1 : 0) +
    filters.categoryIds.length +
    filters.accountIds.length +
    (filters.amount !== null ? 1 : 0) +
    (filters.source !== "all" ? 1 : 0)
  );
}

function buildFilterChips(
  filters: TransactionFiltersState,
  onChange: (next: Partial<TransactionFiltersState>) => void,
  categoryById: Map<string, CategoryOption>,
  accountById: Map<string, AccountOption>,
): Array<{ key: string; label: string; onRemove: () => void }> {
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
  if (filters.datePreset !== "all") {
    chips.push({
      key: "date",
      label:
        filters.datePreset === "custom"
          ? `${filters.dateFrom || "..."} → ${filters.dateTo || "..."}`
          : DATE_PRESET_LABEL[filters.datePreset],
      onRemove: () => onChange({ datePreset: "all", dateFrom: "", dateTo: "" }),
    });
  }
  for (const id of filters.categoryIds) {
    const label = id === "uncategorized" ? "Uncategorized" : (categoryById.get(id)?.name ?? id);
    chips.push({
      key: `cat-${id}`,
      label,
      onRemove: () => onChange({ categoryIds: filters.categoryIds.filter((c) => c !== id) }),
    });
  }
  for (const id of filters.accountIds) {
    chips.push({
      key: `acct-${id}`,
      label: accountById.get(id)?.label ?? id,
      onRemove: () => onChange({ accountIds: filters.accountIds.filter((a) => a !== id) }),
    });
  }
  if (filters.amount) {
    const { op, value, value2 } = filters.amount;
    const label =
      op === "between"
        ? `Between ${formatMoney(Number(value) || 0)} - ${formatMoney(Number(value2) || 0)}`
        : op === "gt"
          ? `> ${formatMoney(Number(value) || 0)}`
          : op === "lt"
            ? `< ${formatMoney(Number(value) || 0)}`
            : `= ${formatMoney(Number(value) || 0)}`;
    chips.push({ key: "amount", label, onRemove: () => onChange({ amount: null }) });
  }
  if (filters.source !== "all") {
    chips.push({
      key: "source",
      label: SOURCE_LABEL[filters.source],
      onRemove: () => onChange({ source: "all" }),
    });
  }
  return chips;
}

/**
 * Removable active-filter chips. `scrollable` renders them in a single
 * horizontally scrolling row (mobile); otherwise they wrap (desktop).
 */
export function ActiveFilterChips({
  filters,
  onChange,
  categories,
  accounts,
  scrollable = false,
}: {
  filters: TransactionFiltersState;
  onChange: (next: Partial<TransactionFiltersState>) => void;
  categories: CategoryOption[];
  accounts: AccountOption[];
  scrollable?: boolean;
}) {
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const chips = buildFilterChips(filters, onChange, categoryById, accountById);
  if (chips.length === 0) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        scrollable ? "overflow-x-auto pb-0.5 [scrollbar-width:none]" : "flex-wrap",
      )}
    >
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="secondary"
          className="shrink-0 gap-1 pr-1 text-xs font-normal"
        >
          <span className="max-w-48 truncate">{chip.label}</span>
          <button
            type="button"
            onClick={chip.onRemove}
            className="ml-0.5 rounded-full p-0.5 hover:bg-background/60"
            aria-label={`Remove filter ${chip.label}`}
          >
            <IconX className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

export function TransactionFilterBar({
  filters,
  onChange,
  categories,
  accounts,
}: {
  filters: TransactionFiltersState;
  onChange: (next: Partial<TransactionFiltersState>) => void;
  categories: CategoryOption[];
  accounts: AccountOption[];
}) {
  const hasAny = hasActiveFilterDimensions(filters);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <DatesPopover value={filters} onChange={onChange} />
        <CategoriesPopover
          categories={categories}
          value={filters.categoryIds}
          onChange={(v) => onChange({ categoryIds: v })}
        />
        <AccountsPopover
          accounts={accounts}
          value={filters.accountIds}
          onChange={(v) => onChange({ accountIds: v })}
        />
        <AmountsPopover value={filters.amount} onChange={(v) => onChange({ amount: v })} />
        <SourcePopover value={filters.source} onChange={(v) => onChange({ source: v })} />
        {hasAny ? (
          <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
            <IconX className="size-4" />
            Clear all
          </Button>
        ) : null}
      </div>
      <ActiveFilterChips
        filters={filters}
        onChange={onChange}
        categories={categories}
        accounts={accounts}
      />
    </div>
  );
}

/** Multi-select list (categories or accounts) used inside the mobile sheet. */
function SheetMultiSelect({
  placeholder,
  children,
}: {
  placeholder: string;
  children: React.ReactNode;
}) {
  return (
    <Command className="rounded-lg border border-border">
      <CommandInput placeholder={placeholder} />
      <CommandList className="max-h-44">
        <CommandEmpty>Nothing found.</CommandEmpty>
        <CommandGroup>{children}</CommandGroup>
      </CommandList>
    </Command>
  );
}

/**
 * Mobile bottom sheet with every filter control stacked full-width. Changes
 * apply immediately (state lives in the parent); "Done" just closes.
 */
export function TransactionFiltersSheet({
  open,
  onOpenChange,
  filters,
  onChange,
  categories,
  accounts,
  searchScope,
  onSearchScopeChange,
  onFindDuplicates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: TransactionFiltersState;
  onChange: (next: Partial<TransactionFiltersState>) => void;
  categories: CategoryOption[];
  accounts: AccountOption[];
  searchScope: "name" | "all";
  onSearchScopeChange: (scope: "name" | "all") => void;
  onFindDuplicates: () => void;
}) {
  const hasAny = hasActiveFilterDimensions(filters);
  const amount = filters.amount;

  function toggleCategory(id: string) {
    onChange({
      categoryIds: filters.categoryIds.includes(id)
        ? filters.categoryIds.filter((v) => v !== id)
        : [...filters.categoryIds, id],
    });
  }
  function toggleAccount(id: string) {
    onChange({
      accountIds: filters.accountIds.includes(id)
        ? filters.accountIds.filter((v) => v !== id)
        : [...filters.accountIds, id],
    });
  }
  function patchAmount(patch: Partial<AmountFilter>) {
    const next = { ...(amount ?? { op: "exactly" as const, value: "", value2: "" }), ...patch };
    onChange({ amount: next.value.trim() || next.value2.trim() ? next : null });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto rounded-t-2xl p-0">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-base">Filters</SheetTitle>
          <SheetDescription className="sr-only">
            Filter transactions by date, category, account, amount, and source.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 px-4 py-4">
          <section className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Dates</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  "all",
                  "last7",
                  "last30",
                  "last90",
                  "thisMonth",
                  "lastMonth",
                  "thisYear",
                  "lastYear",
                ] as DatePreset[]
              ).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onChange({ datePreset: preset, dateFrom: "", dateTo: "" })}
                  className={cn(
                    "flex h-9 items-center justify-between rounded-md border border-border px-2.5 text-sm transition-colors",
                    filters.datePreset === preset
                      ? "border-primary/40 bg-accent font-medium"
                      : "hover:bg-accent/60",
                  )}
                >
                  {DATE_PRESET_LABEL[preset]}
                  {filters.datePreset === preset ? <IconCheck className="size-4" /> : null}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="date"
                aria-label="From date"
                value={filters.dateFrom}
                onChange={(e) => onChange({ datePreset: "custom", dateFrom: e.target.value })}
                className="h-9 text-xs"
              />
              <Input
                type="date"
                aria-label="To date"
                value={filters.dateTo}
                onChange={(e) => onChange({ datePreset: "custom", dateTo: e.target.value })}
                className="h-9 text-xs"
              />
            </div>
          </section>

          <section className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Categories
              {filters.categoryIds.length > 0 ? ` · ${filters.categoryIds.length} selected` : ""}
            </p>
            <SheetMultiSelect placeholder="Search categories...">
              <CommandItem value="Uncategorized" onSelect={() => toggleCategory("uncategorized")}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: DEFAULT_CATEGORY_COLOR }}
                />
                <span className="flex-1 truncate">Uncategorized</span>
                {filters.categoryIds.includes("uncategorized") ? (
                  <IconCheck className="size-4 shrink-0" />
                ) : null}
              </CommandItem>
              {categories.map((c) => {
                const Icon = iconForCategory(c.icon);
                return (
                  <CommandItem key={c.id} value={c.name} onSelect={() => toggleCategory(c.id)}>
                    <Icon
                      className="size-4 shrink-0"
                      style={{ color: c.color ?? DEFAULT_CATEGORY_COLOR }}
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                    {filters.categoryIds.includes(c.id) ? (
                      <IconCheck className="size-4 shrink-0" />
                    ) : null}
                  </CommandItem>
                );
              })}
            </SheetMultiSelect>
          </section>

          <section className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Accounts
              {filters.accountIds.length > 0 ? ` · ${filters.accountIds.length} selected` : ""}
            </p>
            <SheetMultiSelect placeholder="Search accounts...">
              {accounts.map((a) => (
                <CommandItem key={a.id} value={a.label} onSelect={() => toggleAccount(a.id)}>
                  <MerchantAvatar name={a.institutionName} size="sm" />
                  <span className="flex-1 truncate">{a.label}</span>
                  {filters.accountIds.includes(a.id) ? (
                    <IconCheck className="size-4 shrink-0" />
                  ) : null}
                </CommandItem>
              ))}
            </SheetMultiSelect>
          </section>

          <section className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Amount</p>
            <div className="flex items-center gap-2">
              <Select
                value={amount?.op ?? "exactly"}
                onValueChange={(v) => patchAmount({ op: v as AmountFilter["op"] })}
              >
                <SelectTrigger className="h-9 w-32 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exactly">Exactly</SelectItem>
                  <SelectItem value="between">Between</SelectItem>
                  <SelectItem value="gt">Greater than</SelectItem>
                  <SelectItem value="lt">Less than</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                aria-label="Amount"
                value={amount?.value ?? ""}
                onChange={(e) => patchAmount({ value: e.target.value })}
                className="h-9 min-w-0 flex-1"
                placeholder="$0.00"
              />
              {amount?.op === "between" ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  aria-label="Amount upper bound"
                  value={amount?.value2 ?? ""}
                  onChange={(e) => patchAmount({ value2: e.target.value })}
                  className="h-9 min-w-0 flex-1"
                  placeholder="$0.00"
                />
              ) : null}
            </div>
          </section>

          <section className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Source</p>
            <ToggleGroup
              type="single"
              value={filters.source}
              onValueChange={(v) => v && onChange({ source: v as SourceFilter })}
              className="w-full justify-start gap-1.5"
            >
              {(["all", "imported", "plaid"] as SourceFilter[]).map((opt) => (
                <ToggleGroupItem
                  key={opt}
                  value={opt}
                  size="sm"
                  className="flex-1 rounded-md border border-border data-[state=on]:border-primary/40 data-[state=on]:bg-accent"
                >
                  {SOURCE_LABEL[opt]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </section>

          <section className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Search in</p>
            <ToggleGroup
              type="single"
              value={searchScope}
              onValueChange={(v) => v && onSearchScopeChange(v as "name" | "all")}
              className="w-full justify-start gap-1.5"
            >
              <ToggleGroupItem
                value="name"
                size="sm"
                className="flex-1 rounded-md border border-border data-[state=on]:border-primary/40 data-[state=on]:bg-accent"
              >
                Name only
              </ToggleGroupItem>
              <ToggleGroupItem
                value="all"
                size="sm"
                className="flex-1 rounded-md border border-border data-[state=on]:border-primary/40 data-[state=on]:bg-accent"
              >
                All fields
              </ToggleGroupItem>
            </ToggleGroup>
          </section>

          <Button
            variant="outline"
            size="sm"
            className="justify-center"
            onClick={() => {
              onOpenChange(false);
              onFindDuplicates();
            }}
          >
            <IconCopy className="size-4" />
            Find duplicates
          </Button>
        </div>
        <SheetFooter className="flex-row gap-2 border-t border-border px-4 py-3">
          <Button
            variant="ghost"
            className="flex-1"
            disabled={!hasAny}
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            <IconX className="size-4" />
            Clear all
          </Button>
          <Button className="flex-1" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
