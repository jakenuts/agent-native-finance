/**
 * Full detail for one payment plan: the plan fields, computed nextDueDate/
 * funding, the full amortization schedule (from current balance to payoff),
 * and matched payment history (transactions already linked via
 * payment_plan_id).
 * Read-only. Run:  pnpm action get-payment-plan --id plan_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, paymentPlans, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { amortizationSchedule, daysUntilDue, fundingCheck, nextDueDate } from "../server/lib/payment-plans.js";

export default defineAction({
  description:
    "Full detail for one payment plan: all fields, computed nextDueDate/daysUntil/funding, the full monthly amortization schedule (date/paymentCents/interestCents/principalCents/balanceCents from current balance to payoff), and matched payment history (transactions already linked to this plan via payment_plan_id).",
  schema: z.object({
    id: z.string().describe("Payment plan id."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const rows = await db
      .select()
      .from(paymentPlans)
      .where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.id, id)));
    if (rows.length === 0) throw new Error(`Payment plan ${id} not found.`);
    const p = rows[0];

    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
        currentBalanceCents: accounts.currentBalanceCents,
      })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    const acctById = new Map(acctRows.map((a) => [a.id, a]));

    const today = new Date().toISOString().slice(0, 10);
    const amortization = amortizationSchedule({
      dueDay: p.dueDay,
      paymentCents: p.paymentCents,
      aprBps: p.aprBps,
      termMonths: p.termMonths,
      currentBalanceCents: p.currentBalanceCents,
    });

    const funding = fundingCheck(
      { paymentCents: p.paymentCents, payFromAccountId: p.payFromAccountId },
      acctRows.map((a) => ({
        id: a.id,
        currentBalanceCents: a.currentBalanceCents,
        name: a.name ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : null,
      })),
    );

    const matchedTxns = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        name: transactions.name,
        merchantName: transactions.merchantName,
        amountCents: transactions.amountCents,
        accountId: transactions.accountId,
      })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.paymentPlanId, id)))
      .orderBy(desc(transactions.date));

    const cardAccount = p.cardAccountId ? acctById.get(p.cardAccountId) : undefined;
    const payFromAccount = p.payFromAccountId ? acctById.get(p.payFromAccountId) : undefined;

    return {
      id: p.id,
      name: p.name,
      cardAccountId: p.cardAccountId,
      cardAccountName: cardAccount
        ? `${cardAccount.name ?? "Account"}${cardAccount.mask ? ` ••${cardAccount.mask}` : ""}`
        : null,
      payFromAccountId: p.payFromAccountId,
      payFromAccountName: payFromAccount
        ? `${payFromAccount.name ?? "Account"}${payFromAccount.mask ? ` ••${payFromAccount.mask}` : ""}`
        : null,
      paymentCents: p.paymentCents,
      payment: p.paymentCents / 100,
      dueDay: p.dueDay,
      aprBps: p.aprBps,
      apr: p.aprBps != null ? p.aprBps / 100 : null,
      termMonths: p.termMonths,
      startDate: p.startDate,
      originalBalanceCents: p.originalBalanceCents,
      currentBalanceCents: p.currentBalanceCents,
      currentBalance: (p.currentBalanceCents ?? 0) / 100,
      merchantKey: p.merchantKey,
      status: p.status,
      notes: p.notes,
      profile: p.profile,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      nextDueDate: nextDueDate({ dueDay: p.dueDay }, today),
      daysUntil: daysUntilDue({ dueDay: p.dueDay }, today),
      critical: true,
      funding,
      amortization: {
        rows: amortization.rows.map((r) => ({
          ...r,
          payment: r.paymentCents / 100,
          interest: r.interestCents / 100,
          principal: r.principalCents / 100,
          balance: r.balanceCents / 100,
        })),
        payoffDate: amortization.payoffDate,
        totalInterestCents: amortization.totalInterestCents,
        totalInterest: amortization.totalInterestCents / 100,
      },
      matchedPayments: matchedTxns.map((t) => ({
        transactionId: t.id,
        date: t.date,
        name: t.merchantName || t.name,
        amountCents: t.amountCents,
        amount: t.amountCents / 100,
      })),
    };
  },
});
