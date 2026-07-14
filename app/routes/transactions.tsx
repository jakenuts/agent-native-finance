/**
 * /transactions — Rocket Money-style transaction browser: filter chip bar
 * (dates/categories/accounts/amounts), flat date-grouped list (default =
 * ALL transactions, newest first), infinite "Load more" paging, and a
 * compact detail Sheet opened from the row chevron. Filters are reflected
 * to URL search params so the agent can drive filtered views via `navigate`.
 */
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconEdit,
  IconEyeOff,
  IconEye,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { CategoryChip } from "@/components/finance/CategoryChip";
import { DeleteTransactionsDialog } from "@/components/finance/DeleteTransactionsDialog";
import { DuplicatesPanel } from "@/components/finance/DuplicatesPanel";
import { CategoryAvatar } from "@/components/finance/MerchantAvatar";
import { TransactionDetail } from "@/components/finance/TransactionDetail";
import {
  ActiveFilterChips,
  countActiveFilters,
  EMPTY_FILTERS,
  TransactionFilterBar,
  TransactionFiltersSheet,
  type AccountOption,
  type AmountFilter,
  type CategoryOption,
  type DatePreset,
  type TransactionFiltersState,
} from "@/components/finance/TransactionFilters";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_TITLE } from "@/lib/app-config";
import { DEFAULT_CATEGORY_COLOR, iconForCategory } from "@/lib/category-icons";
import { formatDateHeading, formatSignedMoney } from "@/lib/finance-format";
import { cn } from "@/lib/utils";
import { RuleDialog, type RulePrefill } from "@/components/finance/RuleDialog";

type SearchScope = "name" | "all";

export function meta() {
  return [{ title: `Transactions - ${APP_TITLE}` }];
}

const PAGE_SIZE = 50;

interface ListCategoriesResult {
  categories: Array<{ id: string; name: string; group: string; icon: string | null; color: string | null }>;
  uncategorizedCount: number;
}
interface ListAccountsResult {
  id: string;
  name: string;
  accounts: Array<{ id: string; name: string | null; type: string | null; mask: string | null }>;
}

interface TxRow {
  id: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amount: number;
  pending: boolean;
  categoryId: string | null;
  category: string | null;
  accountId: string;
  accountName: string | null;
  accountMask: string | null;
  institutionName: string | null;
  isIgnored: boolean;
  isTaxDeductible: boolean;
  source: "imported" | "plaid";
}

/** Group already-sorted (desc by date) rows by their YYYY-MM-DD date. */
function groupByDate(rows: TxRow[]): Array<{ date: string; rows: TxRow[] }> {
  const groups: Array<{ date: string; rows: TxRow[] }> = [];
  for (const row of rows) {
    const date = row.date ?? "";
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (last && last.date === date) {
      last.rows.push(row);
    } else {
      groups.push({ date, rows: [row] });
    }
  }
  return groups;
}

function amountToCents(dollarsStr: string): number | undefined {
  const n = Number(dollarsStr);
  if (Number.isNaN(n)) return undefined;
  return Math.round(n * 100);
}

function filtersFromSearchParams(params: URLSearchParams): TransactionFiltersState {
  const categoryId = params.get("categoryId");
  const accountId = params.get("accountId");
  const sourceParam = params.get("source");
  return {
    ...EMPTY_FILTERS,
    categoryIds: categoryId ? [categoryId] : [],
    accountIds: accountId ? [accountId] : [],
    source: sourceParam === "imported" || sourceParam === "plaid" ? sourceParam : "all",
  };
}

export default function TransactionsRoute() {
  useSetPageTitle("Transactions");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [filters, setFilters] = useState<TransactionFiltersState>(() =>
    filtersFromSearchParams(searchParams),
  );
  const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
  const [searchInput, setSearchInput] = useState(() => searchParams.get("search") ?? "");
  const [searchScope, setSearchScope] = useState<SearchScope>(
    () => (searchParams.get("searchScope") === "all" ? "all" : "name"),
  );
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rulePrefill, setRulePrefill] = useState<RulePrefill | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  // Gmail-style "select all matching": when true, bulk actions apply to EVERY
  // transaction matching the current filters (server-side, by filter) rather
  // than the manually-picked ids in `selected`.
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
  const [bulkRenameDraft, setBulkRenameDraft] = useState("");
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false);
  const [deleteSelectionOpen, setDeleteSelectionOpen] = useState(false);
  const [deleteFilterOpen, setDeleteFilterOpen] = useState(false);

  const bulkUpdateMutation = useActionMutation("bulk-update-transactions");
  const bulkUpdateByFilterMutation = useActionMutation("bulk-update-transactions-by-filter");

  // Support arriving with ?categoryId= / ?accountId= / ?recurringId= / ?search=
  // deep links (e.g. from the dashboard's "jump to merchant" links).
  useEffect(() => {
    const categoryId = searchParams.get("categoryId");
    const accountId = searchParams.get("accountId");
    const searchParam = searchParams.get("search");
    if (categoryId || accountId) {
      setFilters((f) => ({
        ...f,
        categoryIds: categoryId ? [categoryId] : f.categoryIds,
        accountIds: accountId ? [accountId] : f.accountIds,
      }));
      setOffset(0);
    }
    if (searchParam) {
      setSearch(searchParam);
      setSearchInput(searchParam);
      setOffset(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const recurringId = searchParams.get("recurringId") ?? undefined;

  const accountsQuery = useActionQuery<ListAccountsResult[]>("list-accounts", {});
  const categoriesQuery = useActionQuery<ListCategoriesResult>("list-categories", {});

  const accountOptions: AccountOption[] = useMemo(() => {
    const insts = accountsQuery.data ?? [];
    return insts.flatMap((inst) =>
      inst.accounts.map((a) => ({
        id: a.id,
        label: `${inst.name} · ${a.name ?? a.type ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}`,
        institutionName: inst.name,
        mask: a.mask,
      })),
    );
  }, [accountsQuery.data]);

  const categoryOptions: CategoryOption[] = useMemo(
    () =>
      (categoriesQuery.data?.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        color: c.color,
      })),
    [categoriesQuery.data],
  );

  const categoryById = useMemo(
    () => new Map(categoryOptions.map((c) => [c.id, c])),
    [categoryOptions],
  );

  // Reflect filters into URL search params so the agent can drive filtered views.
  useEffect(() => {
    const next = new URLSearchParams();
    if (filters.categoryIds.length === 1) next.set("categoryId", filters.categoryIds[0]);
    if (filters.accountIds.length === 1) next.set("accountId", filters.accountIds[0]);
    if (recurringId) next.set("recurringId", recurringId);
    if (filters.datePreset !== "all") next.set("datePreset", filters.datePreset);
    if (filters.dateFrom) next.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) next.set("dateTo", filters.dateTo);
    if (search) next.set("search", search);
    if (searchScope !== "name") next.set("searchScope", searchScope);
    if (filters.source !== "all") next.set("source", filters.source);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, recurringId, search, searchScope]);

  // Selection survives "Load more" (accumulation) but clears whenever the
  // filter/search/scope query key changes.
  useEffect(() => {
    setSelected(new Set());
    setLastCheckedId(null);
    setAllMatchingSelected(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, search, searchScope, recurringId]);

  const amountPayload = useMemo(() => {
    const a = filters.amount;
    if (!a || !a.value.trim()) return undefined;
    const valueCents = amountToCents(a.value);
    if (valueCents === undefined) return undefined;
    if (a.op === "between") {
      const value2Cents = amountToCents(a.value2);
      if (value2Cents === undefined) return undefined;
      return { op: a.op, valueCents, value2Cents };
    }
    return { op: a.op, valueCents };
  }, [filters.amount]);

  const dateArgs = useMemo(() => {
    if (filters.datePreset === "custom") {
      return { dateFrom: filters.dateFrom || undefined, dateTo: filters.dateTo || undefined };
    }
    if (filters.datePreset !== "all") {
      return { datePreset: filters.datePreset as Exclude<DatePreset, "custom" | "all"> };
    }
    return {};
  }, [filters.datePreset, filters.dateFrom, filters.dateTo]);

  const queryArgs = {
    limit: PAGE_SIZE,
    offset,
    search: search || undefined,
    searchScope: search ? searchScope : undefined,
    accountIds: filters.accountIds.length ? filters.accountIds : undefined,
    categoryIds: filters.categoryIds.length ? filters.categoryIds : undefined,
    // JSON string, not object: GET query params can't carry nested objects
    // (the action's schema parses it back — see list-transactions.ts).
    amount: amountPayload ? JSON.stringify(amountPayload) : undefined,
    recurringId,
    source: filters.source !== "all" ? filters.source : undefined,
    ...dateArgs,
  };

  const txQuery = useActionQuery("list-transactions", queryArgs);

  // Accumulate pages client-side for "infinite Load more"; reset whenever the
  // filter/search/query key (everything except offset) changes.
  const queryKeyWithoutOffset = JSON.stringify({ ...queryArgs, offset: undefined });
  const [accumulated, setAccumulated] = useState<TxRow[]>([]);
  const [accumulatedKey, setAccumulatedKey] = useState(queryKeyWithoutOffset);
  useEffect(() => {
    if (!txQuery.data) return;
    const freshRows = txQuery.data.rows as TxRow[];
    if (queryKeyWithoutOffset !== accumulatedKey) {
      setAccumulated(freshRows);
      setAccumulatedKey(queryKeyWithoutOffset);
    } else if (offset === 0) {
      setAccumulated(freshRows);
    } else {
      setAccumulated((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...freshRows.filter((r) => !seen.has(r.id))];
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txQuery.data, queryKeyWithoutOffset]);

  const updateFilters = useCallback((patch: Partial<TransactionFiltersState>) => {
    setOffset(0);
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  function applySearch() {
    setOffset(0);
    setSearch(searchInput.trim());
  }

  /**
   * Merchant name click on a transaction row: jump to the merchant-scoped
   * Spending explorer (chart + history for that merchant). The explorer keeps
   * a "See transactions" link back to the old filtered-list behavior.
   */
  function jumpToMerchant(name: string | null) {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return;
    navigate(`/spending?merchant=${encodeURIComponent(trimmed)}`);
  }

  const total = txQuery.data?.total ?? 0;
  const rows = accumulated;
  const grouped = useMemo(() => groupByDate(rows), [rows]);

  function dayTotal(dayRows: TxRow[]): number {
    return dayRows.reduce((sum, r) => sum + r.amount, 0);
  }

  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someLoadedSelected = rows.some((r) => selected.has(r.id));
  // There are more matching rows on the server than the loaded page — the
  // trigger for the "select all N matching" offer.
  const hasMoreMatching = total > rows.length;

  function toggleSelectAll() {
    // Any un-check (whether all-loaded or all-matching) clears everything.
    if (allMatchingSelected || allLoadedSelected) {
      setAllMatchingSelected(false);
      setSelected(new Set());
      setLastCheckedId(null);
      return;
    }
    setSelected(new Set(rows.map((r) => r.id)));
  }

  /** Expand the selection from the loaded page to every matching transaction. */
  function selectAllMatching() {
    setAllMatchingSelected(true);
    setSelected(new Set(rows.map((r) => r.id)));
  }

  function toggleRow(rowId: string, shiftKey: boolean) {
    // Touching an individual row collapses "all matching" back to explicit ids.
    setAllMatchingSelected(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastCheckedId) {
        const ids = rows.map((r) => r.id);
        const from = ids.indexOf(lastCheckedId);
        const to = ids.indexOf(rowId);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          const shouldSelect = !next.has(rowId);
          for (let i = lo; i <= hi; i++) {
            if (shouldSelect) next.add(ids[i]);
            else next.delete(ids[i]);
          }
          setLastCheckedId(rowId);
          return next;
        }
      }
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      setLastCheckedId(rowId);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
    setLastCheckedId(null);
    setAllMatchingSelected(false);
  }

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  // Full filter args (mirror queryArgs minus paging, incl. recurringId) used by
  // the "select all matching" bulk path so it matches list-transactions exactly.
  const bulkFilterArgs = {
    search: search || undefined,
    searchScope: search ? searchScope : undefined,
    accountIds: filters.accountIds.length ? filters.accountIds : undefined,
    categoryIds: filters.categoryIds.length ? filters.categoryIds : undefined,
    amount: amountPayload ? JSON.stringify(amountPayload) : undefined,
    source: filters.source !== "all" ? filters.source : undefined,
    recurringId,
    ...dateArgs,
  };

  // Effective count of what a bulk action will touch, for confirm affordances.
  const selectedCount = allMatchingSelected ? total : selected.size;
  const bulkPending = bulkUpdateMutation.isPending || bulkUpdateByFilterMutation.isPending;

  function runBulkUpdate(patch: Record<string, unknown>, successMessage: string) {
    const onSuccess = (result: { changed?: number; matched?: number }) => {
      const n = result.changed ?? result.matched ?? 0;
      toast.success(successMessage.replace("{n}", String(n)));
      clearSelection();
    };
    const onError = (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Bulk update failed");

    if (allMatchingSelected) {
      // Apply by filter server-side — never ships thousands of ids to the client.
      bulkUpdateByFilterMutation.mutate({ ...bulkFilterArgs, ...patch, dryRun: false }, { onSuccess, onError });
    } else {
      bulkUpdateMutation.mutate({ transactionIds: selectedIds, ...patch }, { onSuccess, onError });
    }
  }

  function bulkSetCategory(categoryId: string | null, categoryName: string) {
    setBulkCategoryOpen(false);
    runBulkUpdate({ categoryId }, `Set category to ${categoryName} on {n} transactions`);
  }

  function bulkRename() {
    const trimmed = bulkRenameDraft.trim();
    if (!trimmed) return;
    setBulkRenameOpen(false);
    runBulkUpdate({ merchantName: trimmed }, `Renamed {n} transactions to "${trimmed}"`);
  }

  function bulkSetIgnored(isIgnored: boolean) {
    runBulkUpdate({ isIgnored }, isIgnored ? "Ignored {n} transactions" : "Un-ignored {n} transactions");
  }

  // Same filter fields as queryArgs, minus paging — passed to delete-transactions
  // for the filter-wide delete flow so the preview matches list-transactions exactly.
  const filterDeleteArgs = {
    search: search || undefined,
    searchScope: search ? searchScope : undefined,
    accountIds: filters.accountIds.length ? filters.accountIds : undefined,
    categoryIds: filters.categoryIds.length ? filters.categoryIds : undefined,
    amount: amountPayload ? JSON.stringify(amountPayload) : undefined,
    source: filters.source !== "all" ? (filters.source as "imported" | "plaid") : undefined,
    ...dateArgs,
  };

  const activeFilterCount = countActiveFilters(filters);
  const hasActiveFilters = activeFilterCount > 0 || Boolean(search);

  const filterSummaryText = useMemo(() => {
    const parts: string[] = [];
    if (filters.datePreset !== "all") {
      parts.push(
        filters.datePreset === "custom"
          ? `${filters.dateFrom || "..."} to ${filters.dateTo || "..."}`
          : filters.datePreset,
      );
    }
    if (filters.accountIds.length > 0) {
      const labels = filters.accountIds.map((id) => accountOptions.find((a) => a.id === id)?.label ?? id);
      parts.push(`account: ${labels.join(", ")}`);
    }
    if (filters.categoryIds.length > 0) {
      const labels = filters.categoryIds.map(
        (id) => (id === "uncategorized" ? "Uncategorized" : categoryOptions.find((c) => c.id === id)?.name) ?? id,
      );
      parts.push(`category: ${labels.join(", ")}`);
    }
    if (search) parts.push(`search: "${search}"`);
    if (filters.source !== "all") parts.push(`source: ${filters.source}`);
    if (filters.amount) {
      const { op, value, value2 } = filters.amount;
      parts.push(op === "between" ? `amount $${value}-$${value2}` : `amount ${op} $${value}`);
    }
    return parts.join(", ") || "all transactions";
  }, [filters, search, accountOptions, categoryOptions]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Transactions</h1>
        <p className="text-sm text-muted-foreground">
          {total} transaction{total === 1 ? "" : "s"} total.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-72 sm:flex-initial sm:basis-72">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applySearch();
              }}
              onBlur={applySearch}
              placeholder="Search name or merchant..."
              className="pl-8"
            />
          </div>
          {/* Mobile: all filter controls live in the bottom sheet. */}
          <Button
            variant={activeFilterCount > 0 ? "secondary" : "outline"}
            size="sm"
            className="shrink-0 gap-1.5 sm:hidden"
            onClick={() => setFiltersSheetOpen(true)}
          >
            <IconAdjustmentsHorizontal className="size-4" />
            Filters
            {activeFilterCount > 0 ? (
              <Badge variant="outline" className="ml-0.5 px-1.5 text-[10px] tabular-nums">
                {activeFilterCount}
              </Badge>
            ) : null}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="hidden shrink-0 gap-1 sm:inline-flex">
                {searchScope === "name" ? "Name" : "All fields"}
                <IconChevronDown className="size-3.5 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {(
                [
                  { value: "name" as const, label: "Name", hint: "Displayed name only" },
                  { value: "all" as const, label: "All fields", hint: "Includes raw description" },
                ]
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setSearchScope(opt.value);
                    setOffset(0);
                  }}
                  className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span className="flex w-full items-center justify-between">
                    {opt.label}
                    {searchScope === opt.value ? <IconCheck className="size-4" /> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{opt.hint}</span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            className="hidden shrink-0 gap-1.5 sm:inline-flex"
            onClick={() => setDuplicatesOpen(true)}
          >
            <IconCopy className="size-3.5" />
            Find duplicates
          </Button>
          {hasActiveFilters ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 px-2">
                  <IconDots className="size-4" />
                  <span className="sr-only">More actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteFilterOpen(true)}
                >
                  <IconTrash className="size-4" />
                  Delete imported matching filters...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {/* Desktop: inline chip bar. Mobile: just the removable active chips. */}
        <div className="hidden sm:block">
          <TransactionFilterBar
            filters={filters}
            onChange={updateFilters}
            categories={categoryOptions}
            accounts={accountOptions}
          />
        </div>
        <div className="sm:hidden">
          <ActiveFilterChips
            filters={filters}
            onChange={updateFilters}
            categories={categoryOptions}
            accounts={accountOptions}
            scrollable
          />
        </div>
      </div>

      <TransactionFiltersSheet
        open={filtersSheetOpen}
        onOpenChange={setFiltersSheetOpen}
        filters={filters}
        onChange={updateFilters}
        categories={categoryOptions}
        accounts={accountOptions}
        searchScope={searchScope}
        onSearchScopeChange={(scope) => {
          setSearchScope(scope);
          setOffset(0);
        }}
        onFindDuplicates={() => setDuplicatesOpen(true)}
      />

      {/* Full-bleed to the content column: cancel the page's horizontal padding
          so the list spans the full content width and its horizontal padding is
          internal (the px-4/lg:px-6 rows), keeping the checkbox column aligned
          with the page's heading/filters instead of double-indented. Jim added
          sm: in front of -mx-4 so the mobile view didn't run edge to edge as the
          container already did*/}
      <Card className="sm:-mx-4 rounded-2xl shadow-sm lg:-mx-6">
        {/* sm:p-0 (not just p-0) — CardContent's base sm:p-6 survives an
            unprefixed p-0 through tailwind-merge, leaving a desktop gutter. */}
        <CardContent className="p-0 sm:p-0">
          {txQuery.isLoading ? (
            <div className="space-y-2 p-4 lg:p-6">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No transactions match these filters.
            </p>
          ) : (
            <div className="divide-y divide-border">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 lg:px-6">
                <span
                  role="checkbox"
                  aria-checked={
                    allMatchingSelected || allLoadedSelected
                      ? true
                      : someLoadedSelected
                        ? "mixed"
                        : false
                  }
                  aria-label="Select all loaded transactions"
                  tabIndex={0}
                  onClick={toggleSelectAll}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      toggleSelectAll();
                    }
                  }}
                  className="relative flex cursor-pointer items-center justify-center before:absolute before:-inset-3.5 before:content-[''] sm:before:hidden"
                >
                  <Checkbox
                    checked={
                      allMatchingSelected || allLoadedSelected
                        ? true
                        : someLoadedSelected
                          ? "indeterminate"
                          : false
                    }
                    className="pointer-events-none"
                    tabIndex={-1}
                    aria-hidden
                  />
                </span>
                <span className="text-xs text-muted-foreground">
                  {allMatchingSelected
                    ? `All ${total} matching transactions selected`
                    : selected.size > 0
                      ? `${selected.size} selected`
                      : `Select all (${rows.length} loaded)`}
                </span>
                {allMatchingSelected ? (
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Clear selection
                  </button>
                ) : allLoadedSelected && hasMoreMatching ? (
                  <button
                    type="button"
                    onClick={selectAllMatching}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Select all {total} matching transactions
                  </button>
                ) : null}
              </div>
              {grouped.map((group) => (
                <div key={group.date}>
                  <div className="flex items-center justify-between bg-muted/40 px-4 py-1.5 lg:px-6">
                    <span className="text-xs font-medium text-muted-foreground">
                      {formatDateHeading(group.date)}
                    </span>
                    <span className="text-xs font-medium tabular-nums text-muted-foreground">
                      {formatSignedMoney(dayTotal(group.rows))}
                    </span>
                  </div>
                  {group.rows.map((tx) => {
                    const acctLabel = tx.accountName
                      ? `${tx.accountName}${tx.accountMask ? ` ··${tx.accountMask}` : ""}`
                      : null;
                    return (
                      <div
                        key={tx.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDetailId(tx.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setDetailId(tx.id);
                          }
                        }}
                        className={
                          "flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40 lg:px-6" +
                          (tx.isIgnored ? " opacity-50" : "") +
                          (selected.has(tx.id) ? " bg-accent/30" : "")
                        }
                      >
                        <span
                          role="checkbox"
                          aria-checked={selected.has(tx.id)}
                          aria-label={`Select ${tx.merchantName || tx.name || "transaction"}`}
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(tx.id, e.shiftKey);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleRow(tx.id, false);
                            }
                          }}
                          className="relative flex items-center justify-center before:absolute before:-inset-3.5 before:content-[''] sm:before:hidden"
                        >
                          <Checkbox
                            checked={selected.has(tx.id)}
                            className="pointer-events-none"
                            tabIndex={-1}
                            aria-hidden
                          />
                        </span>
                        <CategoryAvatar
                          categoryId={tx.categoryId}
                          icon={tx.categoryId ? categoryById.get(tx.categoryId)?.icon : null}
                          color={tx.categoryId ? categoryById.get(tx.categoryId)?.color : null}
                          fallbackName={tx.merchantName || tx.name}
                          size="md"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                jumpToMerchant(tx.merchantName || tx.name);
                              }}
                              className={cn(
                                "truncate text-left hover:underline",
                                tx.isIgnored && "line-through",
                              )}
                            >
                              {tx.merchantName || tx.name || "Unknown"}
                            </button>
                            {tx.pending ? (
                              <Badge variant="secondary" className="shrink-0 text-[10px]">
                                Pending
                              </Badge>
                            ) : null}
                            {filters.source === "all" && tx.source === "imported" ? (
                              <Badge
                                variant="outline"
                                className="shrink-0 text-[9px] font-normal text-muted-foreground"
                              >
                                import
                              </Badge>
                            ) : null}
                          </div>
                          <div
                            className="flex min-w-0 items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            {acctLabel ? (
                              <>
                                {/* Mobile: mask only — the full institution ·
                                    account · mask label eats the row width. */}
                                <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground sm:hidden">
                                  {tx.accountMask
                                    ? `··${tx.accountMask}`
                                    : (tx.accountName ?? "")}
                                </span>
                                <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
                                  {acctLabel}
                                </span>
                              </>
                            ) : null}
                            <CategoryChip
                              transactionId={tx.id}
                              categoryId={tx.categoryId}
                              categoryName={tx.category}
                            />
                          </div>
                        </div>
                        <span
                          className={
                            (tx.amount < 0
                              ? "shrink-0 text-sm font-semibold tabular-nums text-fin-positive"
                              : "shrink-0 text-sm font-semibold tabular-nums") +
                            (tx.isIgnored ? " line-through" : "")
                          }
                        >
                          {formatSignedMoney(tx.amount)}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {total > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {Math.min(rows.length, total)} of {total}
          </p>
          {rows.length < total ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Load more
            </Button>
          ) : null}
        </div>
      ) : null}

      <TransactionDetail
        transactionId={detailId}
        open={detailId !== null}
        onOpenChange={(open) => !open && setDetailId(null)}
        onAddRule={(prefill) => {
          setRulePrefill(prefill);
          setDetailId(null);
        }}
      />

      <RuleDialog
        open={rulePrefill !== null}
        prefill={rulePrefill}
        onOpenChange={(open) => !open && setRulePrefill(null)}
      />

      <DuplicatesPanel open={duplicatesOpen} onOpenChange={setDuplicatesOpen} />

      {selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-lg">
            <span className="px-1 text-sm font-medium">
              {allMatchingSelected ? `All ${total} matching selected` : `${selected.size} selected`}
            </span>
            <Popover open={bulkCategoryOpen} onOpenChange={setBulkCategoryOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" disabled={bulkPending}>
                  Set category
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-0" align="center" side="top">
                <Command>
                  <CommandInput placeholder="Set category..." />
                  <CommandList>
                    <CommandEmpty>No categories found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem value="Uncategorized" onSelect={() => bulkSetCategory(null, "Uncategorized")}>
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: DEFAULT_CATEGORY_COLOR }}
                        />
                        <span className="flex-1 truncate">Uncategorized</span>
                      </CommandItem>
                      {categoryOptions.map((c) => {
                        const Icon = iconForCategory(c.icon);
                        return (
                          <CommandItem key={c.id} value={c.name} onSelect={() => bulkSetCategory(c.id, c.name)}>
                            <Icon className="size-4 shrink-0" style={{ color: c.color ?? DEFAULT_CATEGORY_COLOR }} />
                            <span className="flex-1 truncate">{c.name}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Popover open={bulkRenameOpen} onOpenChange={setBulkRenameOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" disabled={bulkPending}>
                  <IconEdit className="size-4" />
                  Rename
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="center" side="top">
                <div className="flex flex-col gap-2">
                  <Input
                    autoFocus
                    value={bulkRenameDraft}
                    onChange={(e) => setBulkRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") bulkRename();
                    }}
                    placeholder="New display name"
                  />
                  <Button size="sm" onClick={bulkRename} disabled={!bulkRenameDraft.trim() || bulkPending}>
                    Apply to {selectedCount}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulkSetIgnored(true)}
              disabled={bulkPending}
            >
              <IconEyeOff className="size-4" />
              Ignore
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => bulkSetIgnored(false)}
              disabled={bulkPending}
            >
              <IconEye className="size-4" />
              Un-ignore
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => (allMatchingSelected ? setDeleteFilterOpen(true) : setDeleteSelectionOpen(true))}
            >
              <IconTrash className="size-4" />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              <IconX className="size-4" />
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <DeleteTransactionsDialog
        open={deleteSelectionOpen}
        onOpenChange={setDeleteSelectionOpen}
        mode="selection"
        transactionIds={selectedIds}
        onDeleted={clearSelection}
      />

      <DeleteTransactionsDialog
        open={deleteFilterOpen}
        onOpenChange={setDeleteFilterOpen}
        mode="filter"
        filterArgs={filterDeleteArgs}
        filterSummary={filterSummaryText}
      />
    </div>
  );
}
