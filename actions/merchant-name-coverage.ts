/**
 * Merchant friendly-name coverage report: how many transactions display an
 * enriched/friendly merchant name (Plaid merchant enrichment or an imported
 * CSV's cleaned name) vs falling back to the raw bank descriptor. Answers
 * "which merchants are already covered, and which raw names aren't?" without
 * making the user create rules to find out. Read-only.
 * Run:  pnpm action merchant-name-coverage
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { normalizeMerchantKey } from "../server/lib/recurring.js";

export default defineAction({
  description:
    "Report merchant friendly-name coverage: counts of transactions whose displayed name is an enriched merchant name (Plaid enrichment / imported clean name) vs raw bank descriptors, plus the top uncovered raw names (grouped by normalized merchant, with occurrence counts) — the candidates worth renaming or creating a rule for. Scoped to the active profile by default; pass profile:'all' for both.",
  schema: z.object({
    topUncovered: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("How many top uncovered raw-name merchant groups to return."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ topUncovered, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const rows = await db
      .select({
        name: transactions.name,
        merchantName: transactions.merchantName,
        profile: transactions.profile,
      })
      .from(transactions)
      .where(eq(transactions.ownerEmail, owner));

    const scoped =
      effectiveProfile === "all" ? rows : rows.filter((r) => r.profile === effectiveProfile);

    let enriched = 0; // merchant_name present and meaningfully different from raw
    let identical = 0; // merchant_name present but same as raw (nothing to clean)
    let uncovered = 0; // no merchant_name — raw descriptor is what the user sees
    const uncoveredGroups = new Map<string, { count: number; sample: string }>();
    const coveredMerchants = new Set<string>();

    for (const r of scoped) {
      const raw = (r.name ?? "").trim();
      const friendly = (r.merchantName ?? "").trim();
      if (friendly) {
        coveredMerchants.add(friendly);
        if (raw && friendly.toLowerCase() !== raw.toLowerCase()) enriched++;
        else identical++;
        continue;
      }
      uncovered++;
      const key = normalizeMerchantKey(raw) || "(unnamed)";
      const g = uncoveredGroups.get(key);
      if (g) g.count++;
      else uncoveredGroups.set(key, { count: 1, sample: raw || "(unnamed)" });
    }

    const topUncoveredRows = [...uncoveredGroups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topUncovered)
      .map(([merchantKey, g]) => ({ merchantKey, count: g.count, sampleRawName: g.sample }));

    const total = scoped.length;
    return {
      profile: effectiveProfile,
      total,
      covered: enriched + identical,
      coveredPct: total ? Math.round(((enriched + identical) / total) * 1000) / 10 : 0,
      enrichedDifferentFromRaw: enriched,
      friendlyEqualsRaw: identical,
      uncovered,
      distinctCoveredMerchants: coveredMerchants.size,
      distinctUncoveredMerchants: uncoveredGroups.size,
      topUncovered: topUncoveredRows,
      note: "Displayed name = merchant_name (Plaid enrichment / imported clean name) falling back to raw `name`. 'Uncovered' rows show the raw bank descriptor — the topUncovered groups are the best candidates for a rename or rule.",
    };
  },
});
