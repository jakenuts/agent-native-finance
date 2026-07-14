/**
 * Pin or unpin a saved view (pinned views sort first on /views).
 * Run:  pnpm action pin-saved-view --id sv_xxx --pinned true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { savedViews } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description: "Pin or unpin a saved view. Pinned views sort to the top of /views.",
  schema: z.object({
    id: z.string().describe("Saved view id."),
    pinned: z.boolean().describe("true to pin, false to unpin."),
  }),
  readOnly: false,
  run: async ({ id, pinned }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: savedViews.id })
      .from(savedViews)
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.id, id)));
    if (found.length === 0) throw new Error(`Saved view ${id} not found.`);

    await db
      .update(savedViews)
      .set({ isPinned: pinned, updatedAt: new Date().toISOString() })
      .where(and(eq(savedViews.ownerEmail, owner), eq(savedViews.id, id)));
    return { ok: true, id, pinned };
  },
});
