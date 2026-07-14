/**
 * Scan transactions for a plan's payments (or all active plans if planId is
 * omitted), link matches by setting payment_plan_id, and update the plan's
 * current_balance_cents by applying one amortized payment per matched month.
 * Run:  pnpm action match-plan-payments --planId plan_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { paymentPlans, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { matchPlanPayments } from "../server/lib/payment-plans.js";

export default defineAction({
  description:
    "Scan transactions for one payment plan's payments (or every active plan if planId is omitted): find unlinked transactions matching the plan's merchantKey (if set) and pay-from account, within ±2% of paymentCents, link them (sets payment_plan_id), and update the plan's current_balance_cents by applying an amortized payment per matched month. Returns matched counts per plan. Run this periodically (or after a sync) to keep balances current.",
  schema: z.object({
    planId: z.string().optional().describe("Limit to one plan; omit to scan all active plans."),
  }),
  readOnly: false,
  run: async ({ planId }) => {
    const db = getDb();
    const owner = ownerEmail();

    const conditions = [eq(paymentPlans.ownerEmail, owner)];
    if (planId) conditions.push(eq(paymentPlans.id, planId));
    else conditions.push(eq(paymentPlans.status, "active"));

    const plans = await db
      .select()
      .from(paymentPlans)
      .where(and(...conditions));
    if (planId && plans.length === 0) throw new Error(`Payment plan ${planId} not found.`);

    const results: Array<{ planId: string; name: string; matchedCount: number; newBalanceCents: number }> = [];

    for (const p of plans) {
      const txConditions = [eq(transactions.ownerEmail, owner)];
      if (p.payFromAccountId) txConditions.push(eq(transactions.accountId, p.payFromAccountId));

      const candidates = await db
        .select({
          id: transactions.id,
          date: transactions.date,
          amountCents: transactions.amountCents,
          name: transactions.name,
          merchantName: transactions.merchantName,
          accountId: transactions.accountId,
          paymentPlanId: transactions.paymentPlanId,
        })
        .from(transactions)
        .where(and(...txConditions));

      const result = matchPlanPayments(
        {
          id: p.id,
          paymentCents: p.paymentCents,
          merchantKey: p.merchantKey,
          aprBps: p.aprBps,
          currentBalanceCents: p.currentBalanceCents,
          payFromAccountId: p.payFromAccountId,
        },
        candidates.map((t) => ({
          id: t.id,
          date: t.date ?? "",
          amountCents: t.amountCents,
          name: t.name,
          merchantName: t.merchantName,
          accountId: t.accountId,
          paymentPlanId: t.paymentPlanId,
        })),
      );

      if (result.matched.length > 0) {
        await db
          .update(transactions)
          .set({ paymentPlanId: p.id, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(transactions.ownerEmail, owner),
              inArray(
                transactions.id,
                result.matched.map((m) => m.transactionId),
              ),
            ),
          );

        const nextStatus =
          result.newBalanceCents === 0 && p.status === "active" ? "paid_off" : p.status;

        await db
          .update(paymentPlans)
          .set({
            currentBalanceCents: result.newBalanceCents,
            status: nextStatus,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.id, p.id)));
      }

      results.push({
        planId: p.id,
        name: p.name,
        matchedCount: result.matched.length,
        newBalanceCents: result.newBalanceCents,
      });
    }

    return {
      ok: true,
      plans: results,
      totalMatched: results.reduce((sum, r) => sum + r.matchedCount, 0),
    };
  },
});
