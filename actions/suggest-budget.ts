/**
 * Suggest monthly budget targets per category from recent spend history
 * (median + average over the trailing N months, excluding ignored/transfer
 * categories). The agent's + UI's "auto-fill from my history" tool.
 * Read-only. Run:  pnpm action suggest-budget --lookbackMonths 3
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

const MONTH_RE = /^\d{4}-\d{2}$/;

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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Round a cents amount to a "clean" suggestion (nearest $5 under $200, else nearest $10). */
function roundSuggestion(cents: number): number {
  const dollars = cents / 100;
  const step = dollars < 200 ? 5 : 10;
  return Math.round(Math.round(dollars / step) * step * 100);
}

export default defineAction({
  description:
    "Suggest a monthly budget target per category from recent spend history: median and average monthly spend over the trailing lookbackMonths (default 3), excluding ignored/transfer categories. Returns rounded suggested targets ready to review and save via set-budget-line. Use this for 'set up my budget from my history' / 'auto-fill' flows. Scoped to the active profile by default.",
  schema: z.object({
    month: z
      .string()
      .regex(MONTH_RE, "Expected YYYY-MM")
      .optional()
      .describe("Month the suggestion is for (context only, doesn't affect the calc). Defaults to current month."),
    lookbackMonths: z.coerce.number().int().min(1).max(24).default(3),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ month, lookbackMonths, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;
    const targetMonth = month ?? currentMonth();

    // Lookback window: the `lookbackMonths` calendar months before targetMonth
    // (does not include targetMonth itself, so a mid-month suggestion isn't
    // skewed by a partial current month).
    const lookbackMonthList: string[] = [];
    for (let i = lookbackMonths; i >= 1; i--) lookbackMonthList.push(shiftMonth(targetMonth, -i));
    const { from } = monthRange(lookbackMonthList[0]);
    const { to } = monthRange(lookbackMonthList[lookbackMonthList.length - 1]);

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
          gte(transactions.date, from),
          lt(transactions.date, to),
        ),
      );

    // categoryId -> month -> cents
    const byCat = new Map<string, Map<string, number>>();
    for (const row of txRows) {
      if (row.isIgnored || !row.categoryId) continue;
      const cat = catById.get(row.categoryId);
      if (!cat || cat.group !== "expenses") continue;
      const amt = row.amountCents ?? 0;
      if (amt <= 0) continue;
      const m = (row.date ?? "").slice(0, 7);
      if (!lookbackMonthList.includes(m)) continue;
      let monthMap = byCat.get(row.categoryId);
      if (!monthMap) {
        monthMap = new Map();
        byCat.set(row.categoryId, monthMap);
      }
      monthMap.set(m, (monthMap.get(m) ?? 0) + amt);
    }

    const suggestions = Array.from(byCat.entries()).map(([categoryId, monthMap]) => {
      // Months with no spend still count as $0 for the average/median so a
      // category that was only used once isn't overstated.
      const values = lookbackMonthList.map((m) => monthMap.get(m) ?? 0);
      const avgCents = values.reduce((s, v) => s + v, 0) / values.length;
      const medianCents = median(values);
      const cat = catById.get(categoryId);
      return {
        categoryId,
        name: cat?.name ?? "Unknown",
        icon: cat?.icon ?? null,
        color: cat?.color ?? null,
        avgMonthlySpendCents: Math.round(avgCents),
        medianMonthlySpendCents: Math.round(medianCents),
        suggestedTargetCents: roundSuggestion(medianCents || avgCents),
        monthsWithData: values.filter((v) => v > 0).length,
      };
    });

    suggestions.sort((a, b) => b.suggestedTargetCents - a.suggestedTargetCents);

    return {
      month: targetMonth,
      profile: targetProfile,
      lookbackMonths,
      lookbackRange: { from: lookbackMonthList[0], to: lookbackMonthList[lookbackMonthList.length - 1] },
      suggestions,
    };
  },
});
