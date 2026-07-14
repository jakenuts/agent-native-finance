/**
 * Safe, parameterized finance query engine. Callers describe a query as
 * validated JSON (no raw SQL ever) and this module compiles it with the
 * drizzle query builder using portable operators only, so it runs identically
 * on SQLite, PGlite, and Postgres.
 *
 * Used by the run-finance-query action (the agent's general-purpose analysis
 * tool) and by saved views (fp_saved_views.config.query).
 */
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, lte, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { accounts, categories, transactions } from "../db/schema.js";
import type { ProfileFilter } from "./profile.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const financeQueryFiltersSchema = z.object({
  month: z
    .string()
    .refine((v) => v === "current" || v === "last" || MONTH_RE.test(v), {
      message: "month must be 'current', 'last', or YYYY-MM",
    })
    .optional()
    .describe("Calendar month: 'current', 'last', or YYYY-MM."),
  lastMonths: z
    .number()
    .int()
    .min(1)
    .max(36)
    .optional()
    .describe("Trailing N calendar months including the current one."),
  dateFrom: z.string().regex(DATE_RE).optional().describe("Inclusive YYYY-MM-DD lower bound."),
  dateTo: z.string().regex(DATE_RE).optional().describe("Inclusive YYYY-MM-DD upper bound."),
  categoryIds: z.array(z.string().max(100)).max(50).optional(),
  accountIds: z.array(z.string().max(100)).max(50).optional(),
  search: z.string().max(200).optional().describe("Case-insensitive search term; scope controlled by searchScope."),
  searchScope: z
    .enum(["name", "all"])
    .optional()
    .describe(
      "'name' (default) matches ONLY the displayed primary name (merchant_name if set, else name). 'all' also matches the raw name/merchant fields (legacy behavior).",
    ),
  minCents: z.number().int().optional().describe("Minimum signed amount in cents (1 = outflows only)."),
  maxCents: z.number().int().optional().describe("Maximum signed amount in cents (-1 = inflows only)."),
  includeIgnored: z
    .boolean()
    .optional()
    .describe("Include 'ignored' group categories (transfers/loan payments). Default false."),
});

export const financeQuerySchema = z.object({
  from: z.literal("transactions").describe("Only 'transactions' is supported."),
  filters: financeQueryFiltersSchema.optional(),
  groupBy: z
    .enum(["category", "month", "merchant", "account", "day", "week"])
    .optional()
    .describe(
      "Aggregate by this dimension. 'week' buckets by ISO week (keys are the Monday YYYY-MM-DD). Omit for raw transaction rows.",
    ),
  metric: z
    .enum(["sum", "count", "avg"])
    .optional()
    .describe("Aggregate metric over amount_cents. Default 'sum'."),
  sort: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type FinanceQuery = z.infer<typeof financeQuerySchema>;

export interface FinanceQueryGroupRow {
  key: string;
  label: string;
  valueCents: number;
  count: number;
}

export interface FinanceQueryResult {
  groupBy: FinanceQuery["groupBy"] | null;
  metric: "sum" | "count" | "avg";
  rows: FinanceQueryGroupRow[] | Array<Record<string, unknown>>;
  rowCount: number;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [yearStr, monStr] = month.split("-");
  const total = Number(yearStr) * 12 + (Number(monStr) - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** [from, to) date range for a YYYY-MM month. */
function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${shiftMonth(month, 1)}-01` };
}

/**
 * ISO week start (Monday) for a YYYY-MM-DD date string, as YYYY-MM-DD.
 * Pure string/UTC math — no local-timezone drift. Returns null for malformed
 * input (e.g. a row with an empty date).
 */
export function isoWeekStart(date: string): string | null {
  if (!DATE_RE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const dow = new Date(utc).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const monday = new Date(utc - daysSinceMonday * 86_400_000);
  const yy = monday.getUTCFullYear();
  const mm = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(monday.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** PFC primaries that count as ignored when a txn has no assigned category. */
const IGNORED_PFC = ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"];

/**
 * Run a validated finance query for one owner. All filtering is compiled with
 * drizzle operators — no caller-supplied SQL fragments anywhere.
 */
export async function runFinanceQuery(
  db: Db,
  owner: string,
  query: FinanceQuery,
  profile: ProfileFilter = "all",
): Promise<FinanceQueryResult> {
  const filters = query.filters ?? {};
  const metric = query.metric ?? "sum";
  const limit = Math.min(query.limit ?? 50, 500);

  const conditions: SQL[] = [eq(transactions.ownerEmail, owner)];
  if (profile !== "all") {
    conditions.push(eq(transactions.profile, profile));
  }

  // --- date range ---
  if (filters.month) {
    const m =
      filters.month === "current"
        ? currentMonth()
        : filters.month === "last"
          ? shiftMonth(currentMonth(), -1)
          : filters.month;
    const { from, to } = monthRange(m);
    conditions.push(gte(transactions.date, from));
    conditions.push(lt(transactions.date, to));
  }
  if (filters.lastMonths) {
    const start = shiftMonth(currentMonth(), -(filters.lastMonths - 1));
    const { to } = monthRange(currentMonth());
    conditions.push(gte(transactions.date, `${start}-01`));
    conditions.push(lt(transactions.date, to));
  }
  if (filters.dateFrom) conditions.push(gte(transactions.date, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(transactions.date, filters.dateTo));

  // --- entity filters ---
  if (filters.categoryIds?.length) {
    conditions.push(inArray(transactions.categoryId, filters.categoryIds));
  }
  if (filters.accountIds?.length) {
    conditions.push(inArray(transactions.accountId, filters.accountIds));
  }
  if (filters.search?.trim()) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    if (filters.searchScope === "all") {
      conditions.push(
        sql`(lower(${transactions.name}) LIKE ${needle} OR lower(${transactions.merchantName}) LIKE ${needle})`,
      );
    } else {
      // Default 'name' scope: match only the displayed primary name so a term
      // that only appears in the raw description doesn't produce false hits
      // (e.g. an ATM-fee row whose raw name mentions an unrelated store).
      conditions.push(
        sql`lower(coalesce(${transactions.merchantName}, ${transactions.name})) LIKE ${needle}`,
      );
    }
  }
  if (filters.minCents != null) conditions.push(gte(transactions.amountCents, filters.minCents));
  if (filters.maxCents != null) conditions.push(lte(transactions.amountCents, filters.maxCents));

  // --- lookup maps (labels + ignored-category exclusion) ---
  const catRows = await db
    .select({
      id: categories.id,
      name: categories.name,
      categoryGroup: categories.categoryGroup,
      color: categories.color,
    })
    .from(categories)
    .where(eq(categories.ownerEmail, owner));
  const catById = new Map(catRows.map((c) => [c.id, c]));

  if (!filters.includeIgnored) {
    const ignoredIds = catRows
      .filter((c) => c.categoryGroup === "ignored")
      .map((c) => c.id);
    if (ignoredIds.length > 0) {
      conditions.push(
        sql`(${transactions.categoryId} IS NULL OR ${notInArray(transactions.categoryId, ignoredIds)})`,
      );
    }
    // Uncategorized rows: fall back to the raw Plaid category.
    conditions.push(
      sql`(${transactions.categoryId} IS NOT NULL OR ${transactions.pfcPrimary} IS NULL OR ${notInArray(transactions.pfcPrimary, IGNORED_PFC)})`,
    );
  }

  const where = and(...conditions);

  // --- raw rows (no grouping) ---
  if (!query.groupBy) {
    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        name: transactions.name,
        merchantName: transactions.merchantName,
        amountCents: transactions.amountCents,
        pending: transactions.pending,
        categoryId: transactions.categoryId,
        plaidCategory: transactions.pfcPrimary,
        accountId: transactions.accountId,
        note: transactions.note,
      })
      .from(transactions)
      .where(where)
      .orderBy(query.sort === "asc" ? asc(transactions.date) : desc(transactions.date))
      .limit(limit);
    return {
      groupBy: null,
      metric,
      rowCount: rows.length,
      rows: rows.map((r) => ({
        ...r,
        category: r.categoryId ? (catById.get(r.categoryId)?.name ?? null) : null,
      })),
    };
  }

  // --- week bucketing (ISO weeks, Monday-keyed) ---
  // SQLite and Postgres disagree on week-of-year SQL, so we fetch day-grouped
  // rows (portable) and bucket them into ISO weeks in JS. Sum-of-weeks always
  // equals sum-of-days for the same range by construction.
  if (query.groupBy === "week") {
    const dayExpr = sql<string>`coalesce(${transactions.date}, '')`;
    const dayRows = await db
      .select({
        key: dayExpr,
        sumCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(where)
      .groupBy(dayExpr)
      .orderBy(asc(dayExpr))
      .limit(5000);

    const byWeek = new Map<string, { sumCents: number; count: number }>();
    for (const d of dayRows) {
      const key = isoWeekStart(String(d.key ?? ""));
      if (!key) continue;
      const entry = byWeek.get(key) ?? { sumCents: 0, count: 0 };
      entry.sumCents += Number(d.sumCents ?? 0);
      entry.count += Number(d.count ?? 0);
      byWeek.set(key, entry);
    }

    let weekRows: FinanceQueryGroupRow[] = Array.from(byWeek.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({
        key,
        label: key,
        valueCents:
          metric === "count"
            ? v.count
            : metric === "avg"
              ? v.count > 0
                ? Math.round(v.sumCents / v.count)
                : 0
              : Math.round(v.sumCents),
        count: v.count,
      }));
    if (query.sort === "desc") weekRows = weekRows.reverse();
    weekRows = weekRows.slice(0, limit);
    return { groupBy: "week", metric, rowCount: weekRows.length, rows: weekRows };
  }

  // --- grouped aggregation ---
  const keyExpr: SQL<string> =
    query.groupBy === "category"
      ? sql<string>`coalesce(${transactions.categoryId}, 'uncategorized')`
      : query.groupBy === "month"
        ? sql<string>`substr(${transactions.date}, 1, 7)`
        : query.groupBy === "day"
          ? sql<string>`coalesce(${transactions.date}, '')`
          : query.groupBy === "merchant"
            ? sql<string>`coalesce(${transactions.merchantName}, ${transactions.name}, 'Unknown')`
            : sql<string>`coalesce(${transactions.accountId}, '')`;

  const valueExpr: SQL<number> =
    metric === "count"
      ? sql<number>`count(*)`
      : metric === "avg"
        ? sql<number>`coalesce(avg(${transactions.amountCents}), 0)`
        : sql<number>`coalesce(sum(${transactions.amountCents}), 0)`;

  // Chronological dimensions sort by key; everything else by metric value.
  const chronological = query.groupBy === "month" || query.groupBy === "day";
  const sortDir = query.sort ?? (chronological ? "asc" : "desc");
  const orderExpr = chronological ? keyExpr : valueExpr;

  const grouped = await db
    .select({
      key: keyExpr,
      valueCents: valueExpr,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(where)
    .groupBy(keyExpr)
    .orderBy(sortDir === "asc" ? asc(orderExpr) : desc(orderExpr))
    .limit(limit);

  // Resolve display labels for id-keyed dimensions.
  let acctById = new Map<string, { name: string | null; mask: string | null }>();
  if (query.groupBy === "account") {
    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
      })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    acctById = new Map(acctRows.map((a) => [a.id, { name: a.name, mask: a.mask }]));
  }

  const rows: FinanceQueryGroupRow[] = grouped.map((g) => {
    const key = String(g.key ?? "");
    let label = key;
    if (query.groupBy === "category") {
      label = key === "uncategorized" ? "Uncategorized" : (catById.get(key)?.name ?? key);
    } else if (query.groupBy === "account") {
      const a = acctById.get(key);
      label = a ? `${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}` : key;
    }
    return {
      key,
      label,
      valueCents: Math.round(Number(g.valueCents ?? 0)),
      count: Number(g.count ?? 0),
    };
  });

  return { groupBy: query.groupBy, metric, rowCount: rows.length, rows };
}

/** Saved-view config schema: query + presentation hints, strictly validated. */
export const savedViewConfigSchema = z.object({
  query: financeQuerySchema,
  chart: z
    .object({
      type: z.enum(["bar", "line", "area", "pie", "donut"]),
      xKey: z.string().max(50).optional(),
      yLabel: z.string().max(100).optional(),
    })
    .optional(),
  table: z
    .object({
      columns: z.array(z.string().max(50)).max(12).optional(),
    })
    .optional(),
  metric: z
    .object({
      format: z.enum(["currency", "number"]).optional(),
      compareMonth: z.boolean().optional(),
    })
    .optional(),
});

export type SavedViewConfig = z.infer<typeof savedViewConfigSchema>;
