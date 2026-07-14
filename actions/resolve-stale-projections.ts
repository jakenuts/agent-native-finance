/**
 * Bulk-resolve stale projected-income entries: 'projected' rows whose
 * expected bank date passed more than N days ago (renewal never landed —
 * card failed or the customer churned). Mark them 'missed' or delete them.
 * Run:  pnpm action resolve-stale-projections --olderThanDays 7 --action missed
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { projectedEntries } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Bulk-resolve STALE projected-income entries: rows still 'projected' whose expected bank date passed more than olderThanDays ago (default 7 — matching the window after which runway stops counting them automatically). action 'missed' marks them status='missed' (keeps the history — the renewal didn't land); 'delete' removes them (note: a re-import of the same Recurly CSV would recreate deleted rows, so 'missed' is usually the right call). Suggest running this weekly. Returns the affected rows.",
  schema: z.object({
    olderThanDays: z
      .coerce.number()
      .int()
      .min(0)
      .max(365)
      .default(7)
      .describe("How many days past-due a 'projected' row must be to count as stale."),
    action: z
      .enum(["missed", "delete"])
      .describe("'missed' = mark status missed (keeps history); 'delete' = remove the rows."),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  readOnly: false,
  run: async ({ olderThanDays, action, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - olderThanDays);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const conditions = [
      eq(projectedEntries.ownerEmail, owner),
      eq(projectedEntries.status, "projected"),
      lt(projectedEntries.date, cutoffIso),
    ];
    if (effectiveProfile !== "all") conditions.push(eq(projectedEntries.profile, effectiveProfile));

    const stale = await db
      .select({
        id: projectedEntries.id,
        date: projectedEntries.date,
        name: projectedEntries.name,
        amountCents: projectedEntries.amountCents,
      })
      .from(projectedEntries)
      .where(and(...conditions));

    if (stale.length === 0) {
      return { ok: true, action, matched: 0, entries: [], cutoffDate: cutoffIso };
    }

    const ids = stale.map((s) => s.id);
    if (action === "delete") {
      await db
        .delete(projectedEntries)
        .where(and(eq(projectedEntries.ownerEmail, owner), inArray(projectedEntries.id, ids)));
    } else {
      await db
        .update(projectedEntries)
        .set({ status: "missed", updatedAt: new Date().toISOString() })
        .where(and(eq(projectedEntries.ownerEmail, owner), inArray(projectedEntries.id, ids)));
    }

    return { ok: true, action, matched: stale.length, entries: stale, cutoffDate: cutoffIso };
  },
});
