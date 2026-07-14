/**
 * Update a recurring bill/subscription/income entry (patch of fields).
 * Run:  pnpm action update-recurring --id rec_xxx --isActive false
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, recurring } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Update a recurring bill/subscription/income entry (patch: name, kind, frequency, anchorDate, avgAmountCents, merchantKey, accountId, categoryId, notes, isActive). Pass null to clear an optional field.",
  schema: z.object({
    id: z.string().describe("Recurring id."),
    name: z.string().min(1).max(120).optional(),
    kind: z.enum(["bill", "subscription", "income"]).optional(),
    frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]).optional(),
    anchorDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    avgAmountCents: z.number().int().optional(),
    merchantKey: z.string().max(120).nullable().optional(),
    accountId: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  }),
  readOnly: false,
  run: async ({ id, ...patchArgs }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: recurring.id })
      .from(recurring)
      .where(and(eq(recurring.ownerEmail, owner), eq(recurring.id, id)));
    if (found.length === 0) throw new Error(`Recurring ${id} not found.`);

    if (patchArgs.categoryId) {
      const cat = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.ownerEmail, owner), eq(categories.id, patchArgs.categoryId)));
      if (cat.length === 0) throw new Error(`Category ${patchArgs.categoryId} not found.`);
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchArgs)) {
      if (value !== undefined) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one field.");
    }
    patch.updatedAt = new Date().toISOString();

    await db
      .update(recurring)
      .set(patch)
      .where(and(eq(recurring.ownerEmail, owner), eq(recurring.id, id)));
    return { ok: true, id, updated: Object.keys(patch) };
  },
});
