/**
 * Update a category's name, group, icon, or color (patch of fields).
 * Run:  pnpm action update-category --id cat_xxx --name "New name"
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Update a spending category (patch: name, group, icon, color). Changing `group` changes how its transactions count in analytics.",
  schema: z.object({
    id: z.string().describe("Category id."),
    name: z.string().min(1).max(80).optional(),
    group: z.enum(["expenses", "earnings", "ignored"]).optional(),
    icon: z.string().max(50).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  }),
  readOnly: false,
  run: async ({ id, name, group, icon, color }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.id, id)));
    if (found.length === 0) throw new Error(`Category ${id} not found.`);

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (group !== undefined) patch.categoryGroup = group;
    if (icon !== undefined) patch.icon = icon;
    if (color !== undefined) patch.color = color;
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one of name/group/icon/color.");
    }

    await db
      .update(categories)
      .set(patch)
      .where(and(eq(categories.ownerEmail, owner), eq(categories.id, id)));
    return { ok: true, id, updated: Object.keys(patch) };
  },
});
