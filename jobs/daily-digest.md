---
schedule: "0 7 * * *"
enabled: true
---

# Daily digest

Run the morning finance routine:

1. Sync all institutions: call `plaid-sync` with no arguments. Then refresh
   business renewal projections: `sync-recurly-renewals { profile: "business" }`
   (pass the business checking accountId if one is known from `list-accounts`).
   If it fails because RECURLY_API_KEY isn't configured, skip silently.
2. Review yesterday's new transactions: `run-finance-query` with
   `{ "from": "transactions", "filters": { "dateFrom": "<yesterday>", "dateTo": "<yesterday>" } }`
   (compute yesterday's YYYY-MM-DD from today's date).
3. Auto-categorize anything uncategorized:
   - `list-transactions { categoryId: "uncategorized", limit: 50 }`.
   - For recurring merchants, create a rule (`create-rule`) and apply it
     (`apply-rules` with `dryRun: true` first, then for real).
   - For one-offs where the category is obvious, use
     `set-transaction-category`.
   - Skip anything ambiguous — never guess wildly; leave it uncategorized and
     mention it in the digest instead.
4. Check upcoming bills and cashflow:
   - `upcoming-bills { days: 7 }` — note anything due today or tomorrow.
   - `get-runway { days: 14 }` — check `negativeDates` and `minBalanceCents`.
     If the balance goes negative or dips below ~$500, flag it as a pinch
     point in the digest with the date and the biggest contributing bill
     that day (see `days[].items`). Also check `planFundingWarnings` — any
     entry there is a payment plan whose pay-from account is currently short.
5. Check payment plans (CRITICAL — never miss one):
   - `list-payment-plans { status: "active" }`.
   - For any plan with `daysUntil <= 5` AND `funding.funded === false`, flag it
     at the TOP of the digest, above the runway pinch point: name, amount,
     due date, shortfall, and pay-from account name. This is the single most
     urgent thing in the digest when it applies — the user must move money
     before the due date.
   - Optionally call `match-plan-payments {}` (no `planId`, scans all active
     plans) first, so `paidThisMonth`/balances reflect any payment that
     already cleared since the last run.
6. Post a short digest to chat using the `data-insights` renderer where
   possible: any critical payment-plan funding warning from step 5 (first, if
   present), yesterday's transaction count and total spend, notable
   transactions (large or unusual), what you categorized, upcoming bills in
   the next 7 days, and any runway pinch point from step 4. Keep it under a
   few sentences plus the data widget. If nothing happened, say so briefly.
