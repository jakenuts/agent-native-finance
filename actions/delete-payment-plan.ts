/**
 * Delete a payment plan. Linked transactions keep their history but
 * payment_plan_id is cleared.
 * Run:  pnpm action delete-payment-plan --id plan_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { paymentPlans, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Delete a payment plan. Transactions it matched keep their history but their payment_plan_id is cleared.",
  schema: z.object({
    id: z.string().describe("Payment plan id to delete."),
  }),
  readOnly: false,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: paymentPlans.id })
      .from(paymentPlans)
      .where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.id, id)));
    if (found.length === 0) throw new Error(`Payment plan ${id} not found.`);

    await db
      .update(transactions)
      .set({ paymentPlanId: null })
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.paymentPlanId, id)));

    await db.delete(paymentPlans).where(and(eq(paymentPlans.ownerEmail, owner), eq(paymentPlans.id, id)));
    return { ok: true, deleted: id };
  },
});
