/**
 * List categorization rules ordered by priority.
 * Read-only. Run:  pnpm action list-rules
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, rules } from "../server/db/schema.js";
import { isValidRulePattern } from "../server/lib/categorize.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "List auto-categorization rules ordered by priority (lower runs first; first match wins). Shows match conditions (including regex mode and the exclude term) and the category/merchant each rule sets. `invalid: true` flags a regex-mode rule whose pattern doesn't compile (it never matches anything until fixed). Scoped to the active profile by default; pass profile:'all' to see rules from both.",
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

    const ruleRows = await db
      .select()
      .from(rules)
      .where(
        effectiveProfile !== "all"
          ? and(eq(rules.ownerEmail, owner), eq(rules.profile, effectiveProfile))
          : eq(rules.ownerEmail, owner),
      )
      .orderBy(asc(rules.priority), asc(rules.createdAt));

    const catRows = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.ownerEmail, owner));
    const catName = new Map(catRows.map((c) => [c.id, c.name]));

    return {
      rules: ruleRows.map((r) => ({
        id: r.id,
        priority: r.priority,
        isEnabled: r.isEnabled,
        matchName: r.matchName,
        matchNameMode: r.matchNameMode,
        matchNameExclude: r.matchNameExclude,
        invalid: r.matchNameMode === "regex" && r.matchName ? !isValidRulePattern(r.matchName) : false,
        matchAccountId: r.matchAccountId,
        matchMinCents: r.matchMinCents,
        matchMaxCents: r.matchMaxCents,
        setCategoryId: r.setCategoryId,
        setCategoryName: r.setCategoryId ? (catName.get(r.setCategoryId) ?? null) : null,
        setMerchantName: r.setMerchantName,
        profile: r.profile,
        createdAt: r.createdAt,
      })),
    };
  },
});
