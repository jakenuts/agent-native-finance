/**
 * Update a saved view (patch: name, description, kind, config, position).
 * Run:  pnpm action update-saved-view --id sv_xxx --name "New title"
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { savedViews } from "../server/db/schema.js";
import { savedViewConfigSchema } from "../server/lib/finance-query.js";
import { ownerEmail } from "../server/lib/owner.js";

const configParam = z.preprocess((value) => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}, savedViewConfigSchema);

export default defineAction({
  description:
    "Update a saved view (patch: name, description, kind, config, position). config replaces the whole config object and is strictly validated.",
  schema: z.object({
    id: z.string().describe("Saved view id."),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    kind: z.enum(["chart", "table", "metric"]).optional(),
    config: configParam.optional().describe("Replacement config (object or JSON string)."),
    position: z.number().int().min(0).max(10000).optional(),
  }),
  readOnly: false,
  run: async ({ id, name, description, kind, config, position }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: savedViews.id, kind: savedViews.kind })
      .from(savedViews)
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.id, id)));
    if (found.length === 0) throw new Error(`Saved view ${id} not found.`);

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (kind !== undefined) patch.kind = kind;
    if (config !== undefined) {
      const effectiveKind = kind ?? found[0].kind;
      if (effectiveKind === "chart" && !config.chart) {
        throw new Error("kind 'chart' requires config.chart (e.g. { type: 'bar' }).");
      }
      patch.config = JSON.stringify(config);
    }
    if (position !== undefined) patch.position = position;
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one field.");
    }
    patch.updatedAt = new Date().toISOString();

    await db
      .update(savedViews)
      .set(patch)
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.id, id)));
    return { ok: true, id, updated: Object.keys(patch).filter((k) => k !== "updatedAt") };
  },
});
