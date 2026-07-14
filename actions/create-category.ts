/**
 * Create a custom spending category.
 * Run:  pnpm action create-category --name "Pets" --group expenses
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Create a custom spending category in the active profile. `group` controls analytics: 'expenses' counts as spend, 'earnings' as income, 'ignored' is excluded (transfers etc.). Categories are profile-specific — pass profile to create in the other profile explicitly.",
  schema: z.object({
    name: z.string().min(1).max(80).describe("Display name, e.g. 'Pets'."),
    group: z.enum(["expenses", "earnings", "ignored"]).default("expenses"),
    icon: z.string().max(50).optional().describe("Tabler icon slug, e.g. 'paw'."),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Hex color like #4ade80."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile to create this category in. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async ({ name, group, icon, color, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const dupe = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.ownerEmail, owner),
          eq(categories.name, name),
          eq(categories.profile, targetProfile),
        ),
      );
    if (dupe.length > 0) {
      throw new Error(`A category named "${name}" already exists in this profile (id ${dupe[0].id}).`);
    }

    const id = `cat_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(categories).values({
      id,
      ownerEmail: owner,
      name,
      categoryGroup: group,
      icon: icon ?? null,
      color: color ?? null,
      isSystem: false,
      profile: targetProfile,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, id, name, group, profile: targetProfile };
  },
});
