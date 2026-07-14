/**
 * Report ACTUAL Recurly subscription-charge outcomes over a trailing window
 * (default 3 days): succeeded and failed charges with counts + totals. This is
 * the "what actually happened" companion to the forward-looking projected
 * renewals — instead of reconciling each projection against a bank deposit, we
 * just show recent real outcomes straight from Recurly and let past-due
 * projections auto-drop.
 * Run:  pnpm action recurly-recent-activity --days 3
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { fetchProjectionSourceRecentActivity } from "../server/lib/projection-sources.js";

export default defineAction({
  description:
    "Recent ACTUAL subscription-renewal outcomes from the optional Recurly API projection source over the last `days` (default 3): succeeded charges (count + total) and failed/declined charges (count + total), plus the individual rows. Read-only, straight from the Recurly transactions API — this is the factual 'recent renewal activity' view that replaces per-projection reconciliation. Amounts are POSITIVE dollars (a summary, not signed ledger entries). Requires RECURLY_API_KEY via setup scoped secrets or deployment env; absent when that source is not configured.",
  schema: z.object({
    days: z
      .coerce.number()
      .int()
      .min(1)
      .max(31)
      .default(3)
      .describe("Trailing window in days to report actual renewal outcomes for (default 3)."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ days }) => {
    const activity = await fetchProjectionSourceRecentActivity("recurly-api", days);
    return {
      windowDays: activity.windowDays,
      from: activity.from,
      succeeded: {
        count: activity.succeeded.count,
        totalCents: activity.succeeded.totalCents,
        total: activity.succeeded.totalCents / 100,
      },
      failed: {
        count: activity.failed.count,
        totalCents: activity.failed.totalCents,
        total: activity.failed.totalCents / 100,
      },
      // Cap the row lists so a chatty response can't dump hundreds of rows.
      succeededRows: activity.succeeded.rows.slice(0, 100),
      failedRows: activity.failed.rows.slice(0, 100),
    };
  },
});
