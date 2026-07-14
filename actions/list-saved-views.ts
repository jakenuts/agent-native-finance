/**
 * List saved views (pinned first, then by position).
 * Read-only. Run:  pnpm action list-saved-views
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { savedViews } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "List all saved views (persistent charts/tables/metrics on /views), pinned first. Each row includes its parsed config. Scoped to the active profile by default; pass profile:'all' to see views from both.",
  schema: z.object({
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const rows = await db
      .select()
      .from(savedViews)
      .where(
        effectiveProfile !== "all"
          ? and(eq(savedViews.ownerEmail, owner), eq(savedViews.profile, effectiveProfile))
          : eq(savedViews.ownerEmail, owner),
      )
      .orderBy(desc(savedViews.isPinned), asc(savedViews.position), asc(savedViews.createdAt));

    return {
      views: rows.map((v) => {
        let config: unknown = null;
        try {
          config = JSON.parse(v.config);
        } catch {
          config = null;
        }
        return {
          id: v.id,
          name: v.name,
          description: v.description,
          kind: v.kind,
          config,
          position: v.position,
          isPinned: v.isPinned,
          profile: v.profile,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        };
      }),
    };
  },
});
