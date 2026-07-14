/**
 * Patch a transaction's user-editable fields: display name (merchantName),
 * note, tax-deductible flag, ignored flag. One orthogonal mutation backing
 * the detail panel's edits (agent uses the same action). Category changes
 * stay on set-transaction-category (it has its own lock semantics).
 * Run:  pnpm action update-transaction --id tx_xxx --isTaxDeductible true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { transactions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Update editable fields on a transaction: merchantName (custom display name), note (free text, empty string clears it), isTaxDeductible, isIgnored (excludes it from spend/income analytics much like the 'ignored' category group). Pass only the fields that change.",
  schema: z.object({
    id: z.string().describe("Transaction id."),
    merchantName: z.string().max(120).optional().describe("Custom display name shown instead of the raw Plaid name."),
    note: z.string().max(2000).optional().describe("Free-text note; empty string clears it."),
    isTaxDeductible: z.boolean().optional(),
    isIgnored: z.boolean().optional(),
  }),
  readOnly: false,
  run: async ({ id, merchantName, note, isTaxDeductible, isIgnored }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, id)));
    if (found.length === 0) throw new Error(`Transaction ${id} not found.`);

    const patch: Record<string, unknown> = {};
    if (merchantName !== undefined) patch.merchantName = merchantName.trim() || null;
    if (note !== undefined) patch.note = note.trim() === "" ? null : note;
    if (isTaxDeductible !== undefined) patch.isTaxDeductible = isTaxDeductible;
    if (isIgnored !== undefined) patch.isIgnored = isIgnored;

    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update: pass at least one of merchantName, note, isTaxDeductible, isIgnored.");
    }
    patch.updatedAt = new Date().toISOString();

    await db
      .update(transactions)
      .set(patch)
      .where(and(eq(transactions.ownerEmail, owner), eq(transactions.id, id)));

    return { ok: true, id, updated: Object.keys(patch).filter((k) => k !== "updatedAt") };
  },
});
