/**
 * Retroactively apply categorization rules across non-locked transactions.
 * Supports either a saved ruleId (or all enabled rules), or an inline unsaved
 * rule definition for live preview before the user saves it.
 * Run:  pnpm action apply-rules --dryRun true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { rules, transactions } from "../server/db/schema.js";
import { isValidRulePattern, matchesRule, type CategorizationRule } from "../server/lib/categorize.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile, type Profile } from "../server/lib/profile.js";

/** Local extension of CategorizationRule that tracks which profile the rule belongs to, so a rule never matches the other profile's transactions. */
type ScopedRule = CategorizationRule & { profile: Profile };

const inlineRuleSchema = z.object({
  matchName: z.string().min(1).max(120).optional(),
  matchNameMode: z.enum(["contains", "exact", "regex"]).default("contains"),
  matchNameExclude: z.string().max(120).optional(),
  matchAccountId: z.string().optional(),
  matchMinCents: z.number().int().optional(),
  matchMaxCents: z.number().int().optional(),
  setCategoryId: z.string().optional(),
  setMerchantName: z.string().max(120).optional(),
});

export default defineAction({
  description:
    "Retroactively apply auto-categorization rules to all non-locked transactions. Three modes: (1) omit ruleId/rule to apply every enabled saved rule, (2) pass ruleId to apply one saved rule, (3) pass an inline `rule` definition (not yet saved) to preview what it WOULD match — useful for live preview counts while the user is still editing a rule in the create/edit dialog. Use dryRun=true first to preview: returns matchedCount (transactions a rule matches) and changedCount (rows that would actually change).",
  schema: z.object({
    ruleId: z
      .string()
      .optional()
      .describe("Apply only this saved rule. Omit (and omit `rule`) to apply every enabled rule."),
    rule: inlineRuleSchema
      .optional()
      .describe("Inline, unsaved rule definition to preview (implies dryRun semantics for matching; still honors the dryRun flag for whether writes happen)."),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Preview only: report matched/changed counts without writing."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile the inline `rule` preview targets. Ignored for ruleId/all-rules modes, where each saved rule's own profile is used. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async ({ ruleId, rule, dryRun, profile }) => {
    const db = getDb();
    const owner = ownerEmail();

    let ruleRows: ScopedRule[];

    if (rule) {
      if (ruleId) throw new Error("Pass either ruleId or rule, not both.");
      const hasMatch =
        rule.matchName !== undefined ||
        rule.matchAccountId !== undefined ||
        rule.matchMinCents !== undefined ||
        rule.matchMaxCents !== undefined;
      if (!hasMatch) {
        throw new Error("Inline rule needs at least one match condition.");
      }
      if (!rule.setCategoryId && !rule.setMerchantName) {
        throw new Error("Inline rule needs at least one effect (setCategoryId or setMerchantName).");
      }
      if (rule.matchName && rule.matchNameMode === "regex" && !isValidRulePattern(rule.matchName)) {
        throw new Error(`"${rule.matchName}" is not a valid regular expression.`);
      }
      // An inline (unsaved) rule preview targets a single profile — same
      // resolution as create-rule, so the preview matches what saving it
      // (with the same profile override, or none) would actually apply to.
      const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
      const targetProfile: Profile = effectiveProfile === "all" ? "personal" : effectiveProfile;
      ruleRows = [
        {
          id: "__inline_preview__",
          priority: 0,
          isEnabled: true,
          matchName: rule.matchName ?? null,
          matchNameMode: rule.matchName ? rule.matchNameMode : null,
          matchNameExclude: rule.matchNameExclude ?? null,
          matchAccountId: rule.matchAccountId ?? null,
          matchMinCents: rule.matchMinCents ?? null,
          matchMaxCents: rule.matchMaxCents ?? null,
          setCategoryId: rule.setCategoryId ?? null,
          setMerchantName: rule.setMerchantName ?? null,
          profile: targetProfile,
        },
      ];
      // Inline preview is always a dry run — it isn't a saved rule to apply.
      dryRun = true;
    } else {
      let dbRuleRows = await db
        .select()
        .from(rules)
        .where(
          ruleId
            ? and(eq(rules.ownerEmail, owner), eq(rules.id, ruleId))
            : eq(rules.ownerEmail, owner),
        )
        .orderBy(asc(rules.priority), asc(rules.createdAt));
      if (ruleId && dbRuleRows.length === 0) throw new Error(`Rule ${ruleId} not found.`);
      ruleRows = dbRuleRows.filter((r) => r.isEnabled) as ScopedRule[];
    }

    if (ruleRows.length === 0) {
      return { ok: true, dryRun, matchedCount: 0, changedCount: 0, note: "No enabled rules." };
    }

    // Each rule only matches transactions in ITS OWN profile — a rule saved
    // under 'business' must never recategorize a 'personal' transaction (and
    // vice versa), even in "apply every enabled rule" mode where rules from
    // both profiles are considered together.
    const txns = await db
      .select({
        id: transactions.id,
        name: transactions.name,
        merchantName: transactions.merchantName,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        categoryLocked: transactions.categoryLocked,
        profile: transactions.profile,
      })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.categoryLocked, false)));

    let matchedCount = 0;
    let changedCount = 0;
    const now = new Date().toISOString();

    for (const txn of txns) {
      // First matching rule (by priority) wins — same semantics as sync.
      // A rule may only match a transaction in its own profile.
      let winner: ScopedRule | null = null;
      for (const r of ruleRows) {
        if (r.profile !== txn.profile) continue;
        if (matchesRule(txn, r)) {
          winner = r;
          break;
        }
      }
      if (!winner) continue;
      matchedCount++;

      const nextCategoryId = winner.setCategoryId ?? txn.categoryId ?? null;
      const nextMerchant = winner.setMerchantName ?? txn.merchantName ?? null;
      const changes: Record<string, unknown> = {};
      if (nextCategoryId !== txn.categoryId) changes.categoryId = nextCategoryId;
      if (winner.setMerchantName && nextMerchant !== txn.merchantName) {
        changes.merchantName = nextMerchant;
      }
      if (Object.keys(changes).length === 0) continue;
      changedCount++;

      if (!dryRun) {
        await db
          .update(transactions)
          .set({ ...changes, updatedAt: now })
          .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, txn.id)));
      }
    }

    return {
      ok: true,
      dryRun,
      rulesConsidered: ruleRows.length,
      scannedTransactions: txns.length,
      matchedCount,
      changedCount,
    };
  },
});
