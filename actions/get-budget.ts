/**
 * Monthly budget overview: per-category target vs. actual spend (sign-aware,
 * excludes ignored/transfer categories), unbudgeted spend rows (categories
 * with spend this month but no target), and rollup totals.
 * Read-only. Run:  pnpm action get-budget --month 2026-07
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { budgetLines, categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(month: string): { from: string; to: string } {
  const [yearStr, monStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monStr);
  const from = `${month}-01`;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const nextYear = mon === 12 ? year + 1 : year;
  const to = `${nextYear}-${String(nextMon).padStart(2, "0")}-01`;
  return { from, to };
}

/** Days remaining in `month` (YYYY-MM), counting today, when month is the current month; 0 for past months, full length for future months. */
function daysLeftInMonth(month: string): { daysLeft: number; daysInMonth: number } {
  const [yearStr, monStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monStr);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const today = new Date();
  const isCurrent = today.getFullYear() === year && today.getMonth() + 1 === mon;
  if (!isCurrent) {
    const isPast = year < today.getFullYear() || (year === today.getFullYear() && mon < today.getMonth() + 1);
    return { daysLeft: isPast ? 0 : daysInMonth, daysInMonth };
  }
  return { daysLeft: daysInMonth - today.getDate() + 1, daysInMonth };
}

export default defineAction({
  description:
    "Monthly budget overview: for each budgeted category, target vs. actual spend this month (spentCents, remainingCents, pctUsed), plus unbudgeted spend rows (categories with spend but no target — candidates for 'add target'), and rollup totals (totalTargetCents, totalSpentCents, remainingCents). Spend excludes 'ignored'-group categories (transfers/loan payments) and individually-ignored transactions. Scoped to the active profile by default.",
  schema: z.object({
    month: z
      .string()
      .regex(MONTH_RE, "Expected YYYY-MM")
      .optional()
      .describe("Calendar month, e.g. 2026-07. Defaults to the current month."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ month, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;
    const targetMonth = month ?? currentMonth();
    const { from, to } = monthRange(targetMonth);

    const catRows = await db
      .select({
        id: categories.id,
        name: categories.name,
        group: categories.categoryGroup,
        icon: categories.icon,
        color: categories.color,
      })
      .from(categories)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.profile, targetProfile)));
    const catById = new Map(catRows.map((c) => [c.id, c]));

    const lineRows = await db
      .select({
        id: budgetLines.id,
        categoryId: budgetLines.categoryId,
        targetCents: budgetLines.targetCents,
      })
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.ownerEmail, owner),
          eq(budgetLines.profile, targetProfile),
          eq(budgetLines.month, targetMonth),
        ),
      );
    const targetByCat = new Map(lineRows.map((l) => [l.categoryId, l.targetCents]));

    const txRows = await db
      .select({
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        isIgnored: transactions.isIgnored,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.ownerEmail, owner),
          eq(transactions.profile, targetProfile),
          gte(transactions.date, from),
          lt(transactions.date, to),
        ),
      );

    const spendByCat = new Map<string, number>();
    for (const row of txRows) {
      if (row.isIgnored) continue;
      if (!row.categoryId) continue;
      const cat = catById.get(row.categoryId);
      if (!cat || cat.group !== "expenses") continue;
      const amt = row.amountCents ?? 0;
      if (amt <= 0) continue; // only positive (outflow) amounts count as spend
      spendByCat.set(row.categoryId, (spendByCat.get(row.categoryId) ?? 0) + amt);
    }

    const budgeted = [];
    for (const [categoryId, targetCents] of targetByCat.entries()) {
      const cat = catById.get(categoryId);
      const spentCents = spendByCat.get(categoryId) ?? 0;
      budgeted.push({
        categoryId,
        name: cat?.name ?? "Unknown",
        icon: cat?.icon ?? null,
        color: cat?.color ?? null,
        targetCents,
        spentCents,
        // remaining is target - spent; for a zero-spend ($0) target this is
        // -spent (negative whenever there's any spend).
        remainingCents: targetCents - spentCents,
        // Never divide by zero: a $0 target caps at 100% used on any spend
        // (over budget), 0% when untouched.
        pctUsed:
          targetCents > 0
            ? Math.round((spentCents / targetCents) * 1000) / 10
            : spentCents > 0
              ? 100
              : 0,
      });
    }
    budgeted.sort((a, b) => b.spentCents - a.spentCents);

    const unbudgeted = [];
    for (const [categoryId, spentCents] of spendByCat.entries()) {
      if (targetByCat.has(categoryId)) continue;
      const cat = catById.get(categoryId);
      unbudgeted.push({
        categoryId,
        name: cat?.name ?? "Unknown",
        icon: cat?.icon ?? null,
        color: cat?.color ?? null,
        spentCents,
      });
    }
    unbudgeted.sort((a, b) => b.spentCents - a.spentCents);

    const totalTargetCents = budgeted.reduce((s, b) => s + b.targetCents, 0);
    const totalSpentCents = budgeted.reduce((s, b) => s + b.spentCents, 0);
    const { daysLeft, daysInMonth } = daysLeftInMonth(targetMonth);

    return {
      month: targetMonth,
      profile: targetProfile,
      budgeted,
      unbudgeted: unbudgeted.slice(0, 10),
      rollup: {
        totalTargetCents,
        totalSpentCents,
        remainingCents: totalTargetCents - totalSpentCents,
      },
      daysLeft,
      daysInMonth,
    };
  },
});
