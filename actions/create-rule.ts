/**
 * Create an auto-categorization rule.
 * Run:  pnpm action create-rule --matchName starbucks --setCategoryId cat_dining
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { categories, rules } from "../server/db/schema.js";
import { isValidRulePattern } from "../server/lib/categorize.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Create an auto-categorization rule. Needs at least one match condition (matchName/matchAccountId/matchMinCents/matchMaxCents) and at least one effect (setCategoryId/setMerchantName). matchNameMode 'regex' matches a case-insensitive regular expression against name/merchant (e.g. 'chevron|renner|shell|76|exxon' for gas stations) — invalid patterns are rejected at creation. matchNameExclude is an optional contains-none term: if set, the name/merchant must NOT contain it (e.g. match 'Overdraft', exclude 'Protection' to catch overdraft fees but not overdraft-protection transfers). Applied on every sync; run apply-rules to categorize existing transactions retroactively.",
  schema: z.object({
    matchName: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Match transaction name/merchant (case-insensitive). In 'regex' mode, a regular expression."),
    matchNameMode: z
      .enum(["contains", "exact", "regex"])
      .default("contains")
      .describe("How matchName compares. Default 'contains'. 'regex' = case-insensitive regular expression."),
    matchNameExclude: z
      .string()
      .max(120)
      .optional()
      .describe("Optional contains-none term: name/merchant must NOT contain this (case-insensitive)."),
    matchAccountId: z.string().optional().describe("Only match this account id."),
    matchMinCents: z
      .number()
      .int()
      .optional()
      .describe("Minimum signed amount in cents (positive = outflow)."),
    matchMaxCents: z.number().int().optional().describe("Maximum signed amount in cents."),
    setCategoryId: z.string().optional().describe("Category to assign on match."),
    setMerchantName: z
      .string()
      .max(120)
      .optional()
      .describe("Clean merchant name to assign on match."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(100)
      .describe("Lower runs first; first matching rule wins. Default 100."),
    isEnabled: z.boolean().default(true),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile to create this rule in. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async (args) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, args.profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const hasMatch =
      args.matchName !== undefined ||
      args.matchAccountId !== undefined ||
      args.matchMinCents !== undefined ||
      args.matchMaxCents !== undefined;
    if (!hasMatch) {
      throw new Error(
        "Rule needs at least one match condition (matchName, matchAccountId, matchMinCents, matchMaxCents).",
      );
    }
    if (!args.setCategoryId && !args.setMerchantName) {
      throw new Error("Rule needs at least one effect (setCategoryId or setMerchantName).");
    }
    if (args.matchName && args.matchNameMode === "regex" && !isValidRulePattern(args.matchName)) {
      throw new Error(`"${args.matchName}" is not a valid regular expression.`);
    }

    if (args.setCategoryId) {
      const cat = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.ownerEmail, owner), eq(categories.id, args.setCategoryId)));
      if (cat.length === 0) throw new Error(`Category ${args.setCategoryId} not found.`);
    }

    const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(rules).values({
      id,
      ownerEmail: owner,
      priority: args.priority,
      isEnabled: args.isEnabled,
      matchName: args.matchName ?? null,
      matchNameMode: args.matchName ? args.matchNameMode : null,
      matchNameExclude: args.matchNameExclude ?? null,
      matchAccountId: args.matchAccountId ?? null,
      matchMinCents: args.matchMinCents ?? null,
      matchMaxCents: args.matchMaxCents ?? null,
      setCategoryId: args.setCategoryId ?? null,
      setMerchantName: args.setMerchantName ?? null,
      profile: targetProfile,
      createdAt: new Date().toISOString(),
    });

    return {
      ok: true,
      id,
      hint: "Run apply-rules (optionally with dryRun) to categorize existing transactions.",
    };
  },
});
