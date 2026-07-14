/**
 * Delete a categorization rule. Already-categorized transactions keep their
 * category.
 * Run:  pnpm action delete-rule --id rule_xxx
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { rules } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";

export default defineAction({
  description:
    "Delete an auto-categorization rule. Transactions it already categorized keep their category.",
  schema: z.object({
    id: z.string().describe("Rule id to delete."),
  }),
  readOnly: false,
  run: async ({ id }) => {
    const db = getDb();
    const owner = ownerEmail();

    const found = await db
      .select({ id: rules.id })
      .from(rules)
      .where(and(eq(rules.ownerEmail, owner), eq(rules.id, id)));
    if (found.length === 0) throw new Error(`Rule ${id} not found.`);

    await db.delete(rules).where(and(eq(rules.ownerEmail, owner), eq(rules.id, id)));
    return { ok: true, deleted: id };
  },
});
