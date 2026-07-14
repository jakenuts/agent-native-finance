/**
 * Delete a projected-income ledger entry.
 * Run:  pnpm action delete-projected-entry --id proj_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { projectedEntries } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Delete a projected-income ledger entry by id. Prefer update-projected-entry with status 'missed'/'canceled' when the history is worth keeping (e.g. a failed renewal you want to remember); delete is for entries that shouldn't exist at all. Note: re-importing the same Recurly CSV will recreate a deleted imported row (same external key) — mark it 'canceled' instead to keep it suppressed across re-imports.",
  schema: z.object({
    id: z.string().describe("Projected entry id."),
  }),
  readOnly: false,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: projectedEntries.id, name: projectedEntries.name })
      .from(projectedEntries)
      .where(and(eq(projectedEntries.ownerEmail, owner), eq(projectedEntries.id, id)));
    if (found.length === 0) throw new Error(`Projected entry ${id} not found.`);

    await db
      .delete(projectedEntries)
      .where(and(eq(projectedEntries.ownerEmail, owner), eq(projectedEntries.id, id)));

    return { ok: true, id, deleted: found[0].name };
  },
});
