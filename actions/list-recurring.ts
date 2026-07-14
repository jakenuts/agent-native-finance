/**
 * List recurring bills/subscriptions/income for the current owner, with
 * computed nextDueDate and frequency-normalized monthly cost.
 * Read-only. Run:  pnpm action list-recurring
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, categories, paymentPlans, recurring } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { monthlyizedAmountCents, nextDueDateFrom, type RecurringRow } from "../server/lib/recurring.js";
import { daysUntilDue, nextDueDate as planNextDueDate } from "../server/lib/payment-plans.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "List ALL recurring obligations for the current owner: bills, subscriptions, income, AND active payment plans (`plans` — loan-like critical bills paid from a specific account; every assessment of 'my recurring bills' must include them). Recurring rows include computed nextDueDate and monthlyizedAmountCents (frequency-normalized monthly cost, signed cents). Plan rows are summaries (payment, due day, next due, pay-from account, APR) — for funding/warn depth call list-payment-plans. Scoped to the active profile by default; pass profile:'all' to see both.",
  schema: z.object({
    activeOnly: z.boolean().default(false).describe("Only return active recurrings."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ activeOnly, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const conditions = [eq(recurring.ownerEmail, owner)];
    if (activeOnly) conditions.push(eq(recurring.isActive, true));
    if (effectiveProfile !== "all") conditions.push(eq(recurring.profile, effectiveProfile));

    const rows = await db
      .select()
      .from(recurring)
      .where(and(...conditions));

    const catRows = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.ownerEmail, owner));
    const catName = new Map(catRows.map((c) => [c.id, c.name]));

    const today = new Date().toISOString().slice(0, 10);

    const mapped = rows.map((r) => {
      const recurringItem: RecurringRow = {
        id: r.id,
        name: r.name,
        kind: r.kind as RecurringRow["kind"],
        frequency: r.frequency as RecurringRow["frequency"],
        anchorDate: r.anchorDate,
        avgAmountCents: r.avgAmountCents,
      };
      const nextDueDate = nextDueDateFrom(recurringItem, today);
      return {
        id: r.id,
        name: r.name,
        merchantKey: r.merchantKey,
        kind: r.kind,
        frequency: r.frequency,
        anchorDate: r.anchorDate,
        avgAmountCents: r.avgAmountCents,
        avgAmount: (r.avgAmountCents ?? 0) / 100,
        lastAmountCents: r.lastAmountCents,
        lastSeenDate: r.lastSeenDate,
        accountId: r.accountId,
        categoryId: r.categoryId,
        category: r.categoryId ? (catName.get(r.categoryId) ?? null) : null,
        isActive: r.isActive,
        autoDetected: r.autoDetected,
        notes: r.notes,
        profile: r.profile,
        nextDueDate,
        monthlyizedAmountCents: monthlyizedAmountCents(r.avgAmountCents, recurringItem.frequency),
        monthlyizedAmount: monthlyizedAmountCents(r.avgAmountCents, recurringItem.frequency) / 100,
      };
    });

    // Grouped-ready: sort each group by nextDueDate ascending (nulls last).
    mapped.sort((a, b) => {
      if (!a.nextDueDate) return 1;
      if (!b.nextDueDate) return -1;
      return a.nextDueDate.localeCompare(b.nextDueDate);
    });

    // Active payment plans are recurring obligations too (monthly by nature,
    // loan-like, above-normal priority). Summary shape only — funding/warn
    // detail lives in list-payment-plans.
    const planConditions = [eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.status, "active")];
    if (effectiveProfile !== "all") planConditions.push(eq(paymentPlans.profile, effectiveProfile));
    const planRows = await db
      .select()
      .from(paymentPlans)
      .where(and(...planConditions));
    const acctRows = await db
      .select({
        id: accounts.id,
        // Display name = nickname if set, else the institution name.
        name: sql<string | null>`coalesce(${accounts.displayName}, ${accounts.name})`,
        mask: accounts.mask,
      })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    const acctById = new Map(acctRows.map((a) => [a.id, a]));
    const plans = planRows
      .map((p) => {
        const payFrom = p.payFromAccountId ? acctById.get(p.payFromAccountId) : undefined;
        const due = planNextDueDate({ dueDay: p.dueDay }, today);
        return {
          id: p.id,
          name: p.name,
          kind: "plan" as const,
          critical: true,
          paymentCents: p.paymentCents,
          payment: p.paymentCents / 100,
          monthlyizedAmountCents: p.paymentCents, // plans are monthly by definition
          monthlyizedAmount: p.paymentCents / 100,
          dueDay: p.dueDay,
          nextDueDate: due,
          daysUntil: daysUntilDue({ dueDay: p.dueDay }, today),
          payFromAccountId: p.payFromAccountId,
          payFromAccountName: payFrom ? `${payFrom.name ?? "Account"}${payFrom.mask ? ` ••${payFrom.mask}` : ""}` : null,
          aprBps: p.aprBps,
          termMonths: p.termMonths,
          currentBalanceCents: p.currentBalanceCents,
          profile: p.profile,
        };
      })
      .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));

    const monthlyPlansCents = plans.reduce((s, p) => s + p.paymentCents, 0);

    return {
      bills: mapped.filter((r) => r.kind === "bill"),
      subscriptions: mapped.filter((r) => r.kind === "subscription"),
      income: mapped.filter((r) => r.kind === "income"),
      plans,
      monthlyPlansCents,
      all: mapped,
    };
  },
});
