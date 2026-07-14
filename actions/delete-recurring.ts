/**
 * Delete a recurring bill/subscription/income entry. Linked transactions
 * keep their history but recurring_id is cleared.
 * Run:  pnpm action delete-recurring --id rec_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { recurring, transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Delete a recurring bill/subscription/income entry. Transactions it linked keep their history but their recurring_id is cleared.",
  schema: z.object({
    id: z.string().describe("Recurring id to delete."),
  }),
  readOnly: false,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: recurring.id })
      .from(recurring)
      .where(and(eq(recurring.ownerEmail, owner), eq(recurring.id, id)));
    if (found.length === 0) throw new Error(`Recurring ${id} not found.`);

    await db
      .update(transactions)
      .set({ recurringId: null })
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.recurringId, id)));

    await db.delete(recurring).where(and(eq(recurring.ownerEmail, owner), eq(recurring.id, id)));
    return { ok: true, deleted: id };
  },
});
