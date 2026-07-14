/**
 * Update a payment plan (patch of fields — due day, payment amount, APR,
 * balance, etc. can all change later, e.g. "the due date moved to the 20th").
 * Run:  pnpm action update-payment-plan --id plan_xxx --dueDay 20
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, paymentPlans } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Update a payment plan (patch: name, cardAccountId, payFromAccountId, paymentCents, dueDay, aprBps, termMonths, startDate, originalBalanceCents, currentBalanceCents, merchantKey, status ('active'|'paid_off'|'closed'), notes). All plan terms can change later — due day, payment, APR, and balance are all patchable.",
  schema: z.object({
    id: z.string().describe("Payment plan id."),
    name: z.string().min(1).max(120).optional(),
    cardAccountId: z.string().nullable().optional(),
    payFromAccountId: z.string().optional(),
    paymentCents: z.number().int().positive().optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
    aprBps: z.number().int().min(0).nullable().optional(),
    termMonths: z.number().int().positive().nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    originalBalanceCents: z.number().int().min(0).nullable().optional(),
    currentBalanceCents: z.number().int().min(0).nullable().optional(),
    merchantKey: z.string().max(120).nullable().optional(),
    status: z.enum(["active", "paid_off", "closed"]).optional(),
    notes: z.string().max(2000).nullable().optional(),
  }),
  readOnly: false,
  run: async ({ id, ...patchArgs }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: paymentPlans.id })
      .from(paymentPlans)
      .where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.id, id)));
    if (found.length === 0) throw new Error(`Payment plan ${id} not found.`);

    if (patchArgs.payFromAccountId) {
      const acct = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, patchArgs.payFromAccountId)));
      if (acct.length === 0) throw new Error(`Pay-from account ${patchArgs.payFromAccountId} not found.`);
    }
    if (patchArgs.cardAccountId) {
      const acct = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, patchArgs.cardAccountId)));
      if (acct.length === 0) throw new Error(`Card account ${patchArgs.cardAccountId} not found.`);
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchArgs)) {
      if (value !== undefined) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one field.");
    }
    patch.updatedAt = new Date().toISOString();

    await db
      .update(paymentPlans)
      .set(patch)
      .where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.id, id)));
    return { ok: true, id, updated: Object.keys(patch) };
  },
});
