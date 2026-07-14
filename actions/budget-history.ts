/**
 * Per-category, per-month spend vs. target for the trailing N months — the
 * data behind the /budgets history chart (spend bars vs. target line).
 * Read-only. Run:  pnpm action budget-history --months 12
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { budgetLines, categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

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

/** Return the `count` months ending at (and including) `month`, oldest first. */
function trailingMonths(month: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftMonth(month, -i));
  return out;
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

export default defineAction({
  description:
    "Per-category, per-month spend vs. target over the trailing N months (default 12) — for spend-vs-budget trend reporting. Returns { months: string[], categories: [{ categoryId, name, icon, color, series: [{ month, spentCents, targetCents|null }] }] }. Pass categoryIds to limit to specific categories (defaults to every category that has at least one budget line in range). Scoped to the active profile by default.",
  schema: z.object({
    months: z.coerce.number().int().min(1).max(36).default(12),
    categoryIds: z.array(z.string()).max(50).optional(),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ months, categoryIds, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const monthList = trailingMonths(currentMonth(), months);
    const { from: rangeFrom } = monthRange(monthList[0]);
    const { to: rangeTo } = monthRange(monthList[monthList.length - 1]);

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
        month: budgetLines.month,
        categoryId: budgetLines.categoryId,
        targetCents: budgetLines.targetCents,
      })
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.ownerEmail, owner),
          eq(budgetLines.profile, targetProfile),
          gte(budgetLines.month, monthList[0]),
        ),
      );

    const relevantCategoryIds =
      categoryIds && categoryIds.length > 0
        ? categoryIds
        : Array.from(new Set(lineRows.map((l) => l.categoryId)));

    if (relevantCategoryIds.length === 0) {
      return { months: monthList, categories: [] };
    }

    const targetByCatMonth = new Map<string, number>();
    for (const l of lineRows) {
      if (!relevantCategoryIds.includes(l.categoryId)) continue;
      targetByCatMonth.set(`${l.categoryId}:${l.month}`, l.targetCents);
    }

    const txRows = await db
      .select({
        date: transactions.date,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        isIgnored: transactions.isIgnored,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.ownerEmail, owner),
          eq(transactions.profile, targetProfile),
          gte(transactions.date, rangeFrom),
          lt(transactions.date, rangeTo),
          inArray(transactions.categoryId, relevantCategoryIds),
        ),
      );

    const spendByCatMonth = new Map<string, number>();
    for (const row of txRows) {
      if (row.isIgnored || !row.categoryId) continue;
      const amt = row.amountCents ?? 0;
      if (amt <= 0) continue;
      const m = (row.date ?? "").slice(0, 7);
      if (!monthList.includes(m)) continue;
      const key = `${row.categoryId}:${m}`;
      spendByCatMonth.set(key, (spendByCatMonth.get(key) ?? 0) + amt);
    }

    const result = relevantCategoryIds.map((categoryId) => {
      const cat = catById.get(categoryId);
      return {
        categoryId,
        name: cat?.name ?? "Unknown",
        icon: cat?.icon ?? null,
        color: cat?.color ?? null,
        series: monthList.map((m) => ({
          month: m,
          spentCents: spendByCatMonth.get(`${categoryId}:${m}`) ?? 0,
          targetCents: targetByCatMonth.get(`${categoryId}:${m}`) ?? null,
        })),
      };
    });

    return { months: monthList, categories: result };
  },
});
