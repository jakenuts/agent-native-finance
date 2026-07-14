/**
 * Scan all transactions for recurring patterns (repeated same-merchant
 * charges with consistent cadence and amount). Read-only — never creates
 * anything; the agent/UI reviews candidates and calls create-recurring.
 * Run:  pnpm action detect-recurring
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { detectRecurringCandidates } from "../server/lib/recurring.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Scan transactions for recurring bill/subscription/income patterns (>=3 occurrences of the same merchant with consistent cadence and amount). Read-only — never creates anything. Excludes transactions already linked to an existing recurring and merchant_keys that already have an fp_recurring row. Scoped to the active profile by default; pass profile:'all' to scan across both. Returns candidates with suggested name/kind/frequency/avgAmountCents/nextDueDate/confidence and evidence transaction ids; present them for review and call create-recurring for the ones the user confirms.",
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

    const existing = await db
      .select({ merchantKey: recurring.merchantKey })
      .from(recurring)
      .where(eq(recurring.ownerEmail, owner));
    const existingKeys = new Set(existing.map((r) => r.merchantKey).filter((k): k is string => Boolean(k)));

    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        name: transactions.name,
        merchantName: transactions.merchantName,
      })
      .from(transactions)
      .where(
        effectiveProfile !== "all"
          ? and(eq(transactions.ownerEmail, owner), eq(transactions.profile, effectiveProfile))
          : eq(transactions.ownerEmail, owner),
      );

    const eligible = rows.filter(
      (r): r is typeof r & { date: string } => Boolean(r.date),
    );

    const candidates = detectRecurringCandidates(eligible)
      .filter((c) => !existingKeys.has(c.merchantKey));

    return {
      candidates,
      scannedCount: rows.length,
      excludedExistingMerchantKeys: existingKeys.size,
    };
  },
});
