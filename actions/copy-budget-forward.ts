/**
 * Copy last month's budget lines forward to another month. Skips categories
 * that already have a target set in the destination month.
 * Run:  pnpm action copy-budget-forward --fromMonth 2026-06 --toMonth 2026-07
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { budgetLines } from "../server/db/schema.js";
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

export default defineAction({
  description:
    "Copy budget targets from one month to another (defaults: last month -> current month). Skips categories that already have a target set in the destination month; never overwrites an existing line. Returns counts of lines copied vs. skipped.",
  schema: z.object({
    fromMonth: z.string().regex(MONTH_RE, "Expected YYYY-MM").optional().describe("Source month. Defaults to last month."),
    toMonth: z.string().regex(MONTH_RE, "Expected YYYY-MM").optional().describe("Destination month. Defaults to the current month."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  readOnly: false,
  run: async ({ fromMonth, toMonth, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const to = toMonth ?? currentMonth();
    const from = fromMonth ?? shiftMonth(to, -1);
    if (from === to) throw new Error("fromMonth and toMonth must differ.");

    const sourceLines = await db
      .select({ categoryId: budgetLines.categoryId, targetCents: budgetLines.targetCents })
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.ownerEmail, owner),
          eq(budgetLines.profile, targetProfile),
          eq(budgetLines.month, from),
        ),
      );

    const destLines = await db
      .select({ categoryId: budgetLines.categoryId })
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.ownerEmail, owner),
          eq(budgetLines.profile, targetProfile),
          eq(budgetLines.month, to),
        ),
      );
    const destCategoryIds = new Set(destLines.map((l) => l.categoryId));

    const nowIso = new Date().toISOString();
    let copied = 0;
    let skipped = 0;
    for (const line of sourceLines) {
      if (destCategoryIds.has(line.categoryId)) {
        skipped++;
        continue;
      }
      await db.insert(budgetLines).values({
        id: `bl_${crypto.randomUUID().slice(0, 8)}`,
        ownerEmail: owner,
        profile: targetProfile,
        month: to,
        categoryId: line.categoryId,
        targetCents: line.targetCents,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      copied++;
    }

    return { ok: true, fromMonth: from, toMonth: to, profile: targetProfile, copied, skipped };
  },
});
