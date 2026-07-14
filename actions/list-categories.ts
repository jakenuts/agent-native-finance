/**
 * List spending categories for the current owner (system + custom).
 * Read-only. Run:  pnpm action list-categories
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "List all spending categories (system-seeded and custom) with their group (expenses/earnings/ignored), icon, color, profile, and transaction counts. Scoped to the active profile by default (categories are profile-specific — 'personal' and 'business' each have their own system set); pass profile:'all' to see both.",
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
      .select({
        id: categories.id,
        name: categories.name,
        group: categories.categoryGroup,
        icon: categories.icon,
        color: categories.color,
        isSystem: categories.isSystem,
        profile: categories.profile,
      })
      .from(categories)
      .where(
        effectiveProfile !== "all"
          ? and(eq(categories.ownerEmail, owner), eq(categories.profile, effectiveProfile))
          : eq(categories.ownerEmail, owner),
      )
      .orderBy(asc(categories.name));

    const counts = await db
      .select({
        categoryId: transactions.categoryId,
        n: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(eq(transactions.ownerEmail, owner))
      .groupBy(transactions.categoryId);
    const countBy = new Map(counts.map((c) => [c.categoryId, Number(c.n)]));

    return {
      categories: rows.map((c) => ({
        ...c,
        transactionCount: countBy.get(c.id) ?? 0,
      })),
      uncategorizedCount: countBy.get(null) ?? 0,
    };
  },
});
