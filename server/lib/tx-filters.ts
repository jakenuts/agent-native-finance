/**
 * Shared transaction filter schema + WHERE-condition builder used by both
 * list-transactions (read) and delete-transactions (bulk delete by filter),
 * so the two actions always agree on what a given filter set matches — the
 * user picks a filter in the UI, previews it via list-transactions, then
 * deletes with the identical filter via delete-transactions.
 */
import { z } from "zod";
import { and, eq, gte, inArray, lt, lte, gt, sql, type SQL } from "drizzle-orm";
import { transactions } from "../db/schema.js";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function monthRange(month: string): { from: string; to: string } {
  const [yearStr, monStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monStr); // 1-12
  const from = `${yearStr}-${monStr}-01`;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const nextYear = mon === 12 ? year + 1 : year;
  const to = `${nextYear}-${String(nextMon).padStart(2, "0")}-01`;
  return { from, to };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Resolve a datePreset into an inclusive [from, to) date range (to is exclusive, day after). */
export function rangeForPreset(preset: string): { from: string; to: string } {
  const today = todayIso();
  const tomorrow = addDaysIso(today, 1);
  switch (preset) {
    case "last7":
      return { from: addDaysIso(today, -6), to: tomorrow };
    case "last30":
      return { from: addDaysIso(today, -29), to: tomorrow };
    case "last90":
      return { from: addDaysIso(today, -89), to: tomorrow };
    case "thisMonth": {
      const [y, m] = today.split("-");
      return monthRange(`${y}-${m}`);
    }
    case "lastMonth": {
      const [y, m] = today.split("-");
      const total = Number(y) * 12 + (Number(m) - 1) - 1;
      const py = Math.floor(total / 12);
      const pm = (total % 12) + 1;
      return monthRange(`${py}-${String(pm).padStart(2, "0")}`);
    }
    case "thisYear": {
      const y = today.slice(0, 4);
      return { from: `${y}-01-01`, to: `${Number(y) + 1}-01-01` };
    }
    case "lastYear": {
      const y = Number(today.slice(0, 4)) - 1;
      return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
    }
    default:
      throw new Error(`Unknown datePreset: ${preset}`);
  }
}

/** Same filter fields as list-transactions (minus paging), shared by delete-transactions. */
export const txFilterSchema = {
  accountId: z.string().optional().describe("Legacy single-account filter."),
  accountIds: z.array(z.string()).optional().describe("Filter to any of these account ids."),
  categoryId: z
    .string()
    .optional()
    .describe("Legacy single-category filter; pass 'uncategorized' for no category."),
  categoryIds: z
    .array(z.string())
    .optional()
    .describe("Filter to any of these category ids; include 'uncategorized' in the list for no-category rows."),
  search: z.string().optional().describe("Case-insensitive search term; scope controlled by searchScope."),
  searchScope: z
    .enum(["name", "all"])
    .default("name")
    .describe(
      "'name' (default) matches ONLY the displayed primary name (merchant_name if set, else name). 'all' matches merchant_name and name.",
    ),
  month: z
    .string()
    .regex(MONTH_RE, "Expected YYYY-MM")
    .optional()
    .describe("Legacy: filter to a calendar month, e.g. 2026-07."),
  dateFrom: z.string().regex(DATE_RE).optional().describe("Inclusive start date YYYY-MM-DD."),
  dateTo: z.string().regex(DATE_RE).optional().describe("Inclusive end date YYYY-MM-DD."),
  datePreset: z
    .enum(["last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear", "lastYear"])
    .optional()
    .describe("Relative date range; use for asks like 'last 3 months' -> last90."),
  amount: z
    .preprocess((value) => {
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    }, z.object({
      op: z.enum(["exactly", "between", "gt", "lt"]),
      valueCents: z.number().int().describe("Signed cents; for 'between' this is the lower bound."),
      value2Cents: z.number().int().optional().describe("Upper bound cents, required for 'between'."),
    }))
    .optional()
    .describe("Filter by signed amount in cents. May be passed as a JSON string."),
  includeIgnored: z.boolean().default(true).describe("Include transactions marked ignored."),
  recurringId: z.string().optional().describe("Filter to transactions linked to this recurring entry."),
  source: z
    .enum(["imported", "plaid"])
    .optional()
    .describe(
      "Filter by data source: 'imported' = Rocket Money CSV rows (plaid_transaction_id starts 'rm_'), 'plaid' = real Plaid-synced rows. Omit for both.",
    ),
};

export type TxFilterArgs = {
  accountId?: string;
  accountIds?: string[];
  categoryId?: string;
  categoryIds?: string[];
  search?: string;
  searchScope?: "name" | "all";
  month?: string;
  dateFrom?: string;
  dateTo?: string;
  datePreset?: "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear" | "lastYear";
  amount?: { op: "exactly" | "between" | "gt" | "lt"; valueCents: number; value2Cents?: number };
  includeIgnored?: boolean;
  recurringId?: string;
  source?: "imported" | "plaid";
};

/** True when at least one real filter field (beyond includeIgnored's default) is set. */
export function hasAnyFilter(args: TxFilterArgs): boolean {
  return Boolean(
    (args.accountId && args.accountId.trim()) ||
      (args.accountIds && args.accountIds.length > 0) ||
      (args.categoryId && args.categoryId.trim()) ||
      (args.categoryIds && args.categoryIds.length > 0) ||
      (args.search && args.search.trim()) ||
      args.month ||
      args.dateFrom ||
      args.dateTo ||
      args.datePreset ||
      args.amount ||
      args.recurringId ||
      args.source ||
      args.includeIgnored === false,
  );
}

/** Build the WHERE-clause conditions array for these filters (excludes ownerEmail/profile — caller adds those). */
export function buildTxFilterConditions(args: TxFilterArgs): SQL[] {
  const {
    accountId,
    accountIds,
    categoryId,
    categoryIds,
    search,
    searchScope,
    month,
    dateFrom,
    dateTo,
    datePreset,
    amount,
    includeIgnored,
    recurringId,
    source,
  } = args;

  const conditions: SQL[] = [];

  const allAccountIds = [...(accountId ? [accountId] : []), ...(accountIds ?? [])];
  if (allAccountIds.length === 1) {
    conditions.push(eq(transactions.accountId, allAccountIds[0]));
  } else if (allAccountIds.length > 1) {
    conditions.push(inArray(transactions.accountId, allAccountIds));
  }

  const allCategoryIds = [...(categoryId ? [categoryId] : []), ...(categoryIds ?? [])];
  if (allCategoryIds.length > 0) {
    const wantsUncategorized = allCategoryIds.includes("uncategorized");
    const realIds = allCategoryIds.filter((c) => c !== "uncategorized");
    if (wantsUncategorized && realIds.length > 0) {
      conditions.push(sql`(${transactions.categoryId} IS NULL OR ${inArray(transactions.categoryId, realIds)})`);
    } else if (wantsUncategorized) {
      conditions.push(sql`${transactions.categoryId} IS NULL`);
    } else if (realIds.length === 1) {
      conditions.push(eq(transactions.categoryId, realIds[0]));
    } else if (realIds.length > 1) {
      conditions.push(inArray(transactions.categoryId, realIds));
    }
  }

  // Date resolution precedence: explicit dateFrom/dateTo > datePreset > legacy month.
  if (dateFrom || dateTo) {
    if (dateFrom) conditions.push(gte(transactions.date, dateFrom));
    if (dateTo) conditions.push(lte(transactions.date, dateTo));
  } else if (datePreset) {
    const { from, to } = rangeForPreset(datePreset);
    conditions.push(gte(transactions.date, from));
    conditions.push(lt(transactions.date, to));
  } else if (month) {
    const { from, to } = monthRange(month);
    conditions.push(gte(transactions.date, from));
    conditions.push(lt(transactions.date, to));
  }

  if (search && search.trim()) {
    const needle = `%${search.trim().toLowerCase()}%`;
    if (searchScope === "all") {
      conditions.push(
        sql`(lower(${transactions.name}) LIKE ${needle} OR lower(${transactions.merchantName}) LIKE ${needle})`,
      );
    } else {
      conditions.push(sql`lower(coalesce(${transactions.merchantName}, ${transactions.name})) LIKE ${needle}`);
    }
  }

  if (amount) {
    if (amount.op === "exactly") {
      conditions.push(eq(transactions.amountCents, amount.valueCents));
    } else if (amount.op === "gt") {
      conditions.push(gt(transactions.amountCents, amount.valueCents));
    } else if (amount.op === "lt") {
      conditions.push(lt(transactions.amountCents, amount.valueCents));
    } else if (amount.op === "between") {
      if (amount.value2Cents == null) {
        throw new Error("amount.value2Cents is required when op is 'between'.");
      }
      const lo = Math.min(amount.valueCents, amount.value2Cents);
      const hi = Math.max(amount.valueCents, amount.value2Cents);
      conditions.push(gte(transactions.amountCents, lo));
      conditions.push(lte(transactions.amountCents, hi));
    }
  }

  if (includeIgnored === false) {
    conditions.push(sql`(${transactions.isIgnored} IS NULL OR ${transactions.isIgnored} = false)`);
  }

  if (recurringId) {
    conditions.push(eq(transactions.recurringId, recurringId));
  }

  // Prefix-test via substr rather than LIKE 'rm_%' — avoids LIKE wildcard
  // escaping entirely (the '_' in 'rm_' is a single-char LIKE wildcard, and
  // ESCAPE clause syntax isn't reliably supported by the underlying driver).
  if (source === "imported") {
    conditions.push(sql`substr(${transactions.plaidTransactionId}, 1, 3) = 'rm_'`);
  } else if (source === "plaid") {
    conditions.push(sql`substr(${transactions.plaidTransactionId}, 1, 3) != 'rm_'`);
  }

  return conditions;
}

export { and };
