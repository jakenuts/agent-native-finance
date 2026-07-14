/**
 * General-purpose, safe finance analysis query (no raw SQL). Powers ad-hoc
 * agent analysis and saved views.
 * Read-only. Run:
 *   pnpm action run-finance-query --query '{"from":"transactions","groupBy":"category","metric":"sum"}'
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { financeQuerySchema, runFinanceQuery } from "../server/lib/finance-query.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

/** Accept the query as an object or as a JSON string (GET query-param form). */
const queryParam = z.preprocess((value) => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value; // let the schema produce a proper validation error
    }
  }
  return value;
}, financeQuerySchema);

export default defineAction({
  description:
    "Run a safe, parameterized analysis query over transactions: filter by month ('current'/'last'/YYYY-MM), lastMonths, date range, categories, accounts, search, amount range; group by category/month/merchant/account/day/week (week = ISO weeks, keys are the Monday YYYY-MM-DD) with sum/count/avg over amount_cents. Amounts are signed cents (positive = spend). 'ignored' categories (transfers, loan payments) are excluded unless includeIgnored. Tip: filters.minCents=1 restricts to outflows for spending analyses. Omit groupBy for raw transaction rows.",
  schema: z.object({
    query: queryParam.describe(
      'Query object, e.g. {"from":"transactions","filters":{"month":"current","minCents":1},"groupBy":"category","metric":"sum"}. May be passed as a JSON string.',
    ),
    profile: z
      .enum(["personal", "business", "all"])
      .optional()
      .describe("Override the active profile scope for this call."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ query, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    return runFinanceQuery(db, owner, query, effectiveProfile);
  },
});
