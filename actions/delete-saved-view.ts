/**
 * Delete a saved view.
 * Run:  pnpm action delete-saved-view --id sv_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { savedViews } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description: "Delete a saved view from the /views page. Confirm with the user first.",
  schema: z.object({
    id: z.string().describe("Saved view id to delete."),
  }),
  readOnly: false,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: savedViews.id, name: savedViews.name })
      .from(savedViews)
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.id, id)));
    if (found.length === 0) throw new Error(`Saved view ${id} not found.`);

    await db
      .delete(savedViews)
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.id, id)));
    return { ok: true, deleted: id, name: found[0].name };
  },
});
