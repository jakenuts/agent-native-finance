/**
 * Update a categorization rule (patch of fields).
 * Run:  pnpm action update-rule --id rule_xxx --isEnabled false
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, rules } from "../server/db/schema.js";
import { isValidRulePattern } from "../server/lib/categorize.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Update an auto-categorization rule (patch: match conditions, effects, priority, isEnabled). Pass null to clear an optional field. matchNameMode 'regex' requires matchName to be a valid regular expression (validated here). matchNameExclude: pass null to clear, or a string that name/merchant must NOT contain.",
  schema: z.object({
    id: z.string().describe("Rule id."),
    matchName: z.string().min(1).max(120).nullable().optional(),
    matchNameMode: z.enum(["contains", "exact", "regex"]).optional(),
    matchNameExclude: z.string().max(120).nullable().optional(),
    matchAccountId: z.string().nullable().optional(),
    matchMinCents: z.number().int().nullable().optional(),
    matchMaxCents: z.number().int().nullable().optional(),
    setCategoryId: z.string().nullable().optional(),
    setMerchantName: z.string().max(120).nullable().optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    isEnabled: z.boolean().optional(),
  }),
  readOnly: false,
  run: async ({ id, ...patchArgs }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select()
      .from(rules)
      .where(and(eq(rules.ownerEmail, owner), eq(rules.id, id)));
    if (found.length === 0) throw new Error(`Rule ${id} not found.`);

    if (patchArgs.setCategoryId) {
      const cat = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(eq(categories.ownerEmail, owner), eq(categories.id, patchArgs.setCategoryId)),
        );
      if (cat.length === 0) throw new Error(`Category ${patchArgs.setCategoryId} not found.`);
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchArgs)) {
      if (value !== undefined) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one field.");
    }

    // Guard: the resulting rule must keep >=1 match condition and >=1 effect.
    const next = { ...found[0], ...patch };
    const hasMatch =
      next.matchName != null ||
      next.matchAccountId != null ||
      next.matchMinCents != null ||
      next.matchMaxCents != null;
    if (!hasMatch) throw new Error("Update would leave the rule with no match conditions.");
    if (next.setCategoryId == null && next.setMerchantName == null) {
      throw new Error("Update would leave the rule with no effects.");
    }
    if (next.matchName && next.matchNameMode === "regex" && !isValidRulePattern(next.matchName)) {
      throw new Error(`"${next.matchName}" is not a valid regular expression.`);
    }

    await db
      .update(rules)
      .set(patch)
      .where(and(eq(rules.ownerEmail, owner), eq(rules.id, id)));
    return { ok: true, id, updated: Object.keys(patch) };
  },
});
