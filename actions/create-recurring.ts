/**
 * Create a recurring bill, subscription, or income entry.
 * Run:  pnpm action create-recurring --name Netflix --kind subscription --frequency monthly --anchorDate 2026-07-01 --avgAmountCents 1599
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, recurring } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { normalizeMerchantKey } from "../server/lib/recurring.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Create a recurring bill, subscription, or income entry. `anchorDate` is any known occurrence date (YYYY-MM-DD); future due dates are derived from it + frequency. Pass merchantKey (or it's derived from name) so future synced transactions auto-link to this recurring.",
  schema: z.object({
    name: z.string().min(1).max(120).describe("Display name, e.g. 'Netflix' or 'Rent'."),
    kind: z.enum(["bill", "subscription", "income"]),
    frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]),
    anchorDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("A known occurrence date (YYYY-MM-DD); day-of-month/weekday is derived from this."),
    avgAmountCents: z
      .number()
      .int()
      .describe("Typical signed amount in cents (positive = outflow/bill, negative = inflow/income)."),
    merchantKey: z
      .string()
      .max(120)
      .optional()
      .describe("Normalized match pattern for auto-linking transactions; derived from name if omitted."),
    accountId: z.string().optional(),
    categoryId: z.string().optional(),
    notes: z.string().max(500).optional(),
    autoDetected: z.boolean().default(false),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile to create this recurring in. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async (args) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, args.profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    if (args.categoryId) {
      const cat = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.ownerEmail, owner), eq(categories.id, args.categoryId)));
      if (cat.length === 0) throw new Error(`Category ${args.categoryId} not found.`);
    }

    const merchantKey = args.merchantKey?.trim() || normalizeMerchantKey(args.name);
    const id = `rec_${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    await db.insert(recurring).values({
      id,
      ownerEmail: owner,
      name: args.name,
      merchantKey: merchantKey || null,
      kind: args.kind,
      frequency: args.frequency,
      anchorDate: args.anchorDate,
      avgAmountCents: args.avgAmountCents,
      lastAmountCents: args.avgAmountCents,
      lastSeenDate: args.anchorDate,
      accountId: args.accountId ?? null,
      categoryId: args.categoryId ?? null,
      isActive: true,
      autoDetected: args.autoDetected,
      notes: args.notes ?? null,
      profile: targetProfile,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return { ok: true, id, merchantKey };
  },
});
