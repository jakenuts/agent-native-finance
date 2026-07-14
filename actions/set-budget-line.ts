/**
 * Create/update/delete a single monthly budget target for one category.
 * Upsert semantics on (owner, profile, month, categoryId). targetCents: 0 is a
 * legitimate "spend nothing" target (the line persists); negatives are rejected.
 * Deletion is explicit via remove: true.
 * Run:  pnpm action set-budget-line --month 2026-07 --categoryId cat_groceries --targetCents 40000
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { budgetLines, categories } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

const MONTH_RE = /^\d{4}-\d{2}$/;

export default defineAction({
  description:
    "Create or update (upsert on month+category) a monthly budget target for one category, or delete the line. `targetCents` is the monthly spend target in cents: 0 is a LEGITIMATE 'spend nothing' target — the line persists and any spend in that category shows as over budget — it does NOT delete. Negative `targetCents` is rejected. To delete a budget line, pass `remove: true` (targetCents is ignored). Scoped to the active profile by default.",
  schema: z.object({
    month: z.string().regex(MONTH_RE, "Expected YYYY-MM"),
    categoryId: z.string().describe("Category id to set a target for."),
    targetCents: z
      .coerce.number()
      .int()
      .min(0, "targetCents must be >= 0. Use remove: true to delete a budget line.")
      .optional()
      .default(0)
      .describe(
        "Monthly spend target in cents. 0 is a legitimate 'spend nothing' target (line persists, any spend counts as over budget); it does NOT delete. Negative is rejected. Ignored when remove is true.",
      ),
    remove: z
      .coerce.boolean()
      .optional()
      .default(false)
      .describe("Delete the budget line for this category/month instead of upserting. Defaults false."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  readOnly: false,
  run: async ({ month, categoryId, targetCents, remove, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const cat = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.id, categoryId)));
    if (cat.length === 0) throw new Error(`Category ${categoryId} not found.`);

    const existing = await db
      .select({ id: budgetLines.id })
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.ownerEmail, owner),
          eq(budgetLines.profile, targetProfile),
          eq(budgetLines.month, month),
          eq(budgetLines.categoryId, categoryId),
        ),
      );

    if (remove) {
      if (existing.length > 0) {
        await db.delete(budgetLines).where(eq(budgetLines.id, existing[0].id));
        return { ok: true, deleted: true, month, categoryId, profile: targetProfile };
      }
      return { ok: true, deleted: false, month, categoryId, profile: targetProfile };
    }

    const nowIso = new Date().toISOString();
    if (existing.length > 0) {
      await db
        .update(budgetLines)
        .set({ targetCents, updatedAt: nowIso })
        .where(eq(budgetLines.id, existing[0].id));
      return { ok: true, id: existing[0].id, month, categoryId, targetCents, profile: targetProfile };
    }

    const id = `bl_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(budgetLines).values({
      id,
      ownerEmail: owner,
      profile: targetProfile,
      month,
      categoryId,
      targetCents,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { ok: true, id, month, categoryId, targetCents, profile: targetProfile };
  },
});
