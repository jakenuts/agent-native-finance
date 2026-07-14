/**
 * Create a fixed credit-card/loan payoff plan: fixed monthly payment, fixed
 * lower APR, fixed term, due a specific day-of-month, paid FROM a specific
 * checking account. Treated as a CRITICAL never-miss bill by upcoming-bills
 * and get-runway.
 * Run:  pnpm action create-payment-plan --name "Example Card settlement" --paymentCents 47000 --dueDay 17 --aprBps 725 --termMonths 60 --originalBalanceCents 2200000
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, paymentPlans } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Create a fixed payment plan (e.g. a negotiated credit-card payoff/settlement): fixed monthly paymentCents, dueDay (1-31, clamped for short months), optional aprBps (basis points, e.g. 725 = 7.25%) and termMonths, the cardAccountId being paid down and the REQUIRED payFromAccountId (the checking account the payment must clear from). These are treated as CRITICAL bills — missing a payment is not an option. Use when the user mentions a negotiated payment plan, hardship plan, or settlement with a fixed payment/term.",
  schema: z.object({
    name: z.string().min(1).max(120).describe("Display name, e.g. 'Example Card Visa settlement plan'."),
    cardAccountId: z.string().nullable().optional().describe("The credit card / loan account being paid down."),
    payFromAccountId: z.string().describe("The depository account the payment is funded from."),
    paymentCents: z.number().int().positive().describe("Fixed monthly payment in cents."),
    dueDay: z.number().int().min(1).max(31).describe("Day of month payment is due; clamped for short months."),
    aprBps: z.number().int().min(0).optional().describe("Annual rate in basis points, e.g. 725 = 7.25%."),
    termMonths: z.number().int().positive().optional().describe("Fixed term length in months."),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Plan start date YYYY-MM-DD."),
    originalBalanceCents: z.number().int().min(0).optional(),
    currentBalanceCents: z.number().int().min(0).optional().describe("Defaults to originalBalanceCents if omitted."),
    merchantKey: z
      .string()
      .max(120)
      .optional()
      .describe("Text to match payment transactions against (normalized); used by match-plan-payments."),
    notes: z.string().max(2000).optional(),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile to create this plan in. Defaults to the active profile."),
  }),
  readOnly: false,
  run: async (args) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, args.profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const payFrom = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, args.payFromAccountId)));
    if (payFrom.length === 0) throw new Error(`Pay-from account ${args.payFromAccountId} not found.`);

    if (args.cardAccountId) {
      const card = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, args.cardAccountId)));
      if (card.length === 0) throw new Error(`Card account ${args.cardAccountId} not found.`);
    }

    const id = `plan_${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const originalBalanceCents = args.originalBalanceCents ?? null;
    const currentBalanceCents = args.currentBalanceCents ?? originalBalanceCents;

    await db.insert(paymentPlans).values({
      id,
      ownerEmail: owner,
      profile: targetProfile,
      name: args.name,
      cardAccountId: args.cardAccountId ?? null,
      payFromAccountId: args.payFromAccountId,
      paymentCents: args.paymentCents,
      dueDay: args.dueDay,
      aprBps: args.aprBps ?? null,
      termMonths: args.termMonths ?? null,
      startDate: args.startDate ?? null,
      originalBalanceCents,
      currentBalanceCents,
      merchantKey: args.merchantKey?.trim() || null,
      status: "active",
      notes: args.notes ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return { ok: true, id };
  },
});
