---
schedule: "0 8 * * 1"
enabled: true
---

# Weekly review

Produce the Monday-morning weekly spending review:

1. Make sure data is fresh: call `plaid-sync` with no arguments.
2. Compare last week vs the week before using `run-finance-query` twice with
   `dateFrom`/`dateTo` ranges (Mon–Sun, computed from today's date), grouped
   by category with `metric: "sum"` and `filters.minCents: 1`.
3. Update (or create if missing) a saved view named exactly "Weekly Review":
   - `list-saved-views` → if a view named "Weekly Review" exists, refresh it
     with `update-saved-view`; otherwise `create-saved-view`.
   - Suggested config: kind `chart`,
     `{ "query": { "from": "transactions", "filters": { "dateFrom": "<last monday>", "dateTo": "<last sunday>", "minCents": 1 }, "groupBy": "category", "metric": "sum", "sort": "desc" }, "chart": { "type": "bar" } }`
     and update the description with the week range and total.
4. Surface anomalies in your chat summary:
   - Unusually large transactions (well above that merchant's or category's
     typical amount).
   - New merchants seen for the first time (compare against prior weeks via
     `run-finance-query` grouped by merchant).
   - Categories up sharply week-over-week (call out the top movers with
     percentages).
5. Check budget status: call `get-budget {}` (current month). Call out any
   category that is over budget — use `remainingCents < 0` (this catches a
   zero-target "spend nothing" category with any spend, whose `pctUsed` caps at
   100 rather than exceeding it) — by name and amount over, and any category
   that is not over but at `pctUsed >= 80` as "close to its limit" — weigh this
   against `daysLeft`/`daysInMonth` (80% used with 20 days left is more
   concerning than 80% used with 2 days left). If `rollup.remainingCents` is
   negative, lead with that. Skip this section entirely if no budgets are set
   (`get-budget` returns an empty `budgeted` array) — don't nag the user to
   set up budgets in an automated job.
6. Post the summary to chat (use `data-insights` or `data-table` for the
   category comparison and budget status) and mention that the "Weekly
   Review" view on /views has been updated. If any category is over budget,
   offer `navigate { path: "/budgets" }` so the user can adjust it.
