/**
 * Update a projected-income ledger entry (patch of fields, including status
 * resolution: 'received' | 'missed' | 'canceled').
 * Run:  pnpm action update-projected-entry --id proj_xxx --status received
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts, projectedEntries } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Update a projected-income ledger entry (patch: date, amountCents (signed, negative = income, non-zero), name, accountId (null to clear), notes (null to clear), status). Status lifecycle: 'projected' → 'received' (the money landed), 'missed' (renewal failed/churned), or 'canceled'. Resolving a past-due 'projected' row is how the ledger stays honest — runway only counts 'projected' rows. Setting status back to 'projected' re-arms it.",
  schema: z.object({
    id: z.string().describe("Projected entry id."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Expected BANK date (YYYY-MM-DD)."),
    amountCents: z
      .number()
      .int()
      .refine((v) => v !== 0, { message: "amountCents must be non-zero (negative = income)." })
      .optional(),
    name: z.string().min(1).max(160).optional(),
    accountId: z.string().nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    status: z.enum(["projected", "received", "missed", "canceled"]).optional(),
  }),
  readOnly: false,
  run: async ({ id, ...patchArgs }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: projectedEntries.id })
      .from(projectedEntries)
      .where(and(eq(projectedEntries.ownerEmail, owner), eq(projectedEntries.id, id)));
    if (found.length === 0) throw new Error(`Projected entry ${id} not found.`);

    if (patchArgs.accountId) {
      const acct = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, patchArgs.accountId)));
      if (acct.length === 0) throw new Error(`Account ${patchArgs.accountId} not found.`);
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
      .update(projectedEntries)
      .set(patch)
      .where(and(eq(projectedEntries.ownerEmail, owner), eq(projectedEntries.id, id)));

    return { ok: true, id, updated: Object.keys(patch).filter((k) => k !== "updatedAt") };
  },
});
