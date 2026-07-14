/**
 * Create a persistent saved view (chart/table/metric) rendered on /views.
 * Run:  pnpm action create-saved-view --name "Coffee spend" --kind metric --config '{"query":{...}}'
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { savedViews } from "../server/db/schema.js";
import { savedViewConfigSchema } from "../server/lib/finance-query.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

/** Accept config as an object or JSON string; validate strictly either way. */
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
    "Create a persistent saved view the user sees on the /views page: kind 'chart' (bar/line/area/pie/donut), 'table', or 'metric' (big number, optional month-over-month compare). config = { query: <run-finance-query shape>, chart?/table?/metric? }. Use month:'current' or lastMonths so views stay fresh over time. Pin only when the user asks.",
  schema: z.object({
    name: z.string().min(1).max(120).describe("Display title."),
    description: z.string().max(500).optional(),
    kind: z.enum(["chart", "table", "metric"]),
    config: configParam.describe(
      'View config JSON: { "query": {...}, "chart": {"type":"donut"} } etc. May be a JSON string.',
    ),
    pin: z.boolean().default(false).describe("Pin to the top of /views."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile to create this saved view in. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async ({ name, description, kind, config, pin, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    if (kind === "chart" && !config.chart) {
      throw new Error("kind 'chart' requires config.chart (e.g. { type: 'bar' }).");
    }

    const [{ maxPos } = { maxPos: 0 }] = await db
      .select({ maxPos: sql<number>`coalesce(max(${savedViews.position}), 0)` })
      .from(savedViews)
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.profile, targetProfile)));

    const id = `sv_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await db.insert(savedViews).values({
      id,
      ownerEmail: owner,
      name,
      description: description ?? null,
      kind,
      config: JSON.stringify(config),
      position: Number(maxPos ?? 0) + 1,
      isPinned: pin,
      profile: targetProfile,
      createdAt: now,
      updatedAt: now,
    });

    return { ok: true, id, name, kind, pinned: pin, profile: targetProfile, url: "/views" };
  },
});
