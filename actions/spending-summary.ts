/**
 * Spending summary for a calendar month: totals, by-category breakdown, and a
 * 6-month trend. Uses assigned categories (fp_categories) with their groups:
 * 'ignored' excluded from spend/income, 'earnings' counts as income. Raw
 * Plaid PFC codes are the fallback for uncategorized rows.
 * Read-only. Run:  pnpm action spending-summary --month 2026-07
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

const MONTH_RE = /^\d{4}-\d{2}$/;

/** PFC primaries treated as ignored/earnings when a row has no category. */
const IGNORED_PFC = new Set(["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT"]);
const EARNINGS_PFC = new Set(["INCOME"]);

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonth(month: string): { year: number; mon: number } {
  const [yearStr, monStr] = month.split("-");
  return { year: Number(yearStr), mon: Number(monStr) };
}

function monthRange(month: string): { from: string; to: string } {
  const { year, mon } = parseMonth(month);
  const from = `${month}-01`;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const nextYear = mon === 12 ? year + 1 : year;
  const to = `${nextYear}-${String(nextMon).padStart(2, "0")}-01`;
  return { from, to };
}

/** Return the `count` months ending at (and including) `month`, oldest first. */
function trailingMonths(month: string, count: number): string[] {
  const { year, mon } = parseMonth(month);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const total = year * 12 + (mon - 1) - i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

interface CatInfo {
  name: string;
  group: string;
}

function formatPfc(pfc: string): string {
  return pfc
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Effective analytics group for a row: assigned category group, else PFC. */
function effectiveGroup(
  categoryId: string | null,
  pfcPrimary: string | null,
  catById: Map<string, CatInfo>,
): "expenses" | "earnings" | "ignored" {
  if (categoryId) {
    const g = catById.get(categoryId)?.group;
    if (g === "earnings" || g === "ignored") return g;
    return "expenses";
  }
  if (pfcPrimary && IGNORED_PFC.has(pfcPrimary)) return "ignored";
  if (pfcPrimary && EARNINGS_PFC.has(pfcPrimary)) return "earnings";
  return "expenses";
}

export default defineAction({
  description:
    "Spending summary for a calendar month using assigned categories: total spend/income (ignored-group categories like transfers excluded and reported separately), spend by category, and a 6-month spend trend. Falls back to the raw Plaid category for uncategorized rows.",
  schema: z.object({
    month: z
      .string()
      .regex(MONTH_RE, "Expected YYYY-MM")
      .optional()
      .describe("Calendar month, e.g. 2026-07. Defaults to the current month."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ month, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetMonth = month ?? currentMonth();
    const { from, to } = monthRange(targetMonth);

    const catRows = await db
      .select({
        id: categories.id,
        name: categories.name,
        group: categories.categoryGroup,
      })
      .from(categories)
      .where(eq(categories.ownerEmail, owner));
    const catById = new Map<string, CatInfo>(
      catRows.map((c) => [c.id, { name: c.name, group: c.group }]),
    );

    const monthRows = await db
      .select({
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        pfcPrimary: transactions.pfcPrimary,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.ownerEmail, owner),
          gte(transactions.date, from),
          lt(transactions.date, to),
          ...(effectiveProfile !== "all" ? [eq(transactions.profile, effectiveProfile)] : []),
        ),
      );

    let totalSpendCents = 0;
    let totalIncomeCents = 0;
    let transferCents = 0;
    const byCategory = new Map<
      string,
      { categoryId: string | null; spendCents: number; txCount: number }
    >();

    for (const row of monthRows) {
      const amt = row.amountCents ?? 0;
      const group = effectiveGroup(row.categoryId, row.pfcPrimary, catById);

      if (group === "ignored") {
        transferCents += amt;
        continue;
      }
      if (group === "earnings") {
        totalIncomeCents += -amt; // negative = money in
        continue;
      }
      // expenses: positive = spend, negative = refund (reduces spend)
      totalSpendCents += amt;
      if (amt <= 0) continue; // only positive amounts roll into category spend
      const label = row.categoryId
        ? (catById.get(row.categoryId)?.name ?? "Other")
        : row.pfcPrimary
          ? formatPfc(row.pfcPrimary)
          : "Uncategorized";
      const entry = byCategory.get(label) ?? {
        categoryId: row.categoryId ?? null,
        spendCents: 0,
        txCount: 0,
      };
      entry.spendCents += amt;
      entry.txCount += 1;
      byCategory.set(label, entry);
    }

    const categoryBreakdown = Array.from(byCategory.entries())
      .map(([category, v]) => ({
        category,
        categoryId: v.categoryId,
        spendDollars: v.spendCents / 100,
        txCount: v.txCount,
      }))
      .sort((a, b) => b.spendDollars - a.spendDollars);

    // 6-month trend (oldest -> newest): positive expense amounts only.
    const months = trailingMonths(targetMonth, 6);
    const { from: trendFrom } = monthRange(months[0]);
    const trendRows = await db
      .select({
        date: transactions.date,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        pfcPrimary: transactions.pfcPrimary,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.ownerEmail, owner),
          gte(transactions.date, trendFrom),
          lt(transactions.date, to),
          ...(effectiveProfile !== "all" ? [eq(transactions.profile, effectiveProfile)] : []),
        ),
      );
    const spendByMonth = new Map<string, number>(months.map((m) => [m, 0]));
    for (const row of trendRows) {
      const amt = row.amountCents ?? 0;
      if (amt <= 0) continue;
      if (effectiveGroup(row.categoryId, row.pfcPrimary, catById) !== "expenses") continue;
      const m = (row.date ?? "").slice(0, 7);
      if (spendByMonth.has(m)) spendByMonth.set(m, (spendByMonth.get(m) ?? 0) + amt);
    }
    const trend = months.map((m) => ({
      month: m,
      spendDollars: (spendByMonth.get(m) ?? 0) / 100,
    }));

    return {
      month: targetMonth,
      totalSpend: totalSpendCents / 100,
      totalIncome: totalIncomeCents / 100,
      transfers: transferCents / 100,
      byCategory: categoryBreakdown,
      trend,
    };
  },
});
