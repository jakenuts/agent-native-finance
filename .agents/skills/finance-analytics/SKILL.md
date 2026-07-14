---
name: finance-analytics
description: Worked examples for managing, analyzing, and presenting Finance banking data — categorization with rules, trend charts, reports, recurring-bill detection, runway/cashflow projections, monthly budgets, credit-card payment plans, and interactive generative-UI panels, built from exact action-call sequences. Use when categorizing transactions, analyzing spending, creating saved views, detecting/managing recurring bills, answering cashflow/runway questions, setting up budgets, setting up or checking a payment plan, or building an interactive chat/extension panel.
---

# Finance Analytics Playbook

Exact action sequences for the three jobs you do most. General principles:
cents everywhere (positive = spend), rules > one-off edits, saved views for
anything the user will want again.

## Example 1 — "Categorize all Starbucks as Dining" (+ rule for the future)

Recurring merchant ⇒ create a rule, then apply it retroactively.

1. Find the category id:
   `list-categories` → find "Dining" → e.g. `cat_dining`.
2. Create the rule:
   `create-rule { matchName: "starbucks", matchNameMode: "contains", setCategoryId: "cat_dining", setMerchantName: "Starbucks" }`
3. Preview the impact (always dry-run first):
   `apply-rules { ruleId: "<new rule id>", dryRun: true }` → report
   `matchedCount` / `changedCount` to the user.
4. Apply for real:
   `apply-rules { ruleId: "<new rule id>" }`
5. Confirm: "Categorized N Starbucks transactions as Dining; future ones are
   automatic."

One-off fix instead (single odd transaction): 
`set-transaction-category { transactionId, categoryId: "cat_dining" }` — this
locks it so sync never reverts it.

## Example 2 — "Show my monthly grocery trend" (durable chart)

Repeatable analysis ⇒ saved view, not just a chat answer.

1. Get the Groceries id: `list-categories` → `cat_groceries`.
2. Sanity-check the data first:
   `run-finance-query { query: { from: "transactions", filters: { lastMonths: 6, categoryIds: ["cat_groceries"], minCents: 1 }, groupBy: "month", metric: "sum", sort: "asc" } }`
3. Create the view with the same query:
   ```
   create-saved-view {
     name: "Monthly grocery spend",
     description: "Grocery spending per month, last 6 months.",
     kind: "chart",
     config: {
       query: { from: "transactions",
                filters: { lastMonths: 6, categoryIds: ["cat_groceries"], minCents: 1 },
                groupBy: "month", metric: "sum", sort: "asc" },
       chart: { type: "line", yLabel: "Spend" }
     }
   }
   ```
4. Tell the user it's on /views and offer `navigate { view: "views" }`.
   Pin only if they ask.

Relative filters (`lastMonths`, `month: "current"`) keep the view fresh
forever — never hardcode a month in a saved view unless the user wants a
snapshot of that specific month.

## Example 3 — "Build a subscriptions report"

1. Find candidates — recurring same-merchant charges:
   `run-finance-query { query: { from: "transactions", filters: { lastMonths: 3, minCents: 1 }, groupBy: "merchant", metric: "count", sort: "desc", limit: 50 } }`
   Merchants with count ≥ 2–3/quarter and steady amounts (verify with a raw
   query filtered by `search: "<merchant>"`) are likely subscriptions
   (Netflix, Spotify, iCloud, gyms, SaaS...).
2. Create a "Subscriptions" category if none exists:
   `create-category { name: "Subscriptions", group: "expenses", icon: "repeat", color: "#818cf8" }`
3. One rule per subscription merchant:
   `create-rule { matchName: "netflix", setCategoryId: "<subs id>" }` (repeat)
   then `apply-rules { dryRun: true }` → review → `apply-rules {}`.
4. Durable report:
   ```
   create-saved-view {
     name: "Subscriptions",
     description: "Recurring subscription charges this month.",
     kind: "table",
     config: {
       query: { from: "transactions",
                filters: { month: "current", categoryIds: ["<subs id>"], minCents: 1 },
                groupBy: "merchant", metric: "sum", sort: "desc" },
       table: {}
     }
   }
   ```
5. Optionally add a metric card for the monthly total:
   `create-saved-view { name: "Subscription total", kind: "metric", config: { query: { from: "transactions", filters: { month: "current", categoryIds: ["<subs id>"], minCents: 1 }, metric: "sum" }, metric: { format: "currency", compareMonth: true } } }`

## Example 4 — Detect and add recurring bills

"Find my recurring bills" / "scan for subscriptions".

1. Scan: `detect-recurring {}` → returns candidates like
   `{ merchantKey: "netflix", suggestedName: "NETFLIX.COM", kind: "subscription", frequency: "monthly", avgAmountCents: 1599, confidence: "high", cadenceDescription: "5 charges, ~monthly, avg $15.99", evidenceTxnIds: [...] }`.
2. Present the candidates to the user (the `data-table` renderer works well:
   columns name/cadence/confidence). Don't create anything yet.
3. For confirmed candidates (or all `confidence: "high"` if the user says
   "add the obvious ones"), create each:
   ```
   create-recurring {
     name: "Netflix", kind: "subscription", frequency: "monthly",
     anchorDate: "<candidate.lastDate>", avgAmountCents: 1599,
     merchantKey: "netflix", autoDetected: true
   }
   ```
4. Confirm what was added and offer `navigate { path: "/recurring" }`.

One-off / already-known bill (user just tells you about it, no scan needed):
go straight to `create-recurring` with the details they gave you (name, kind,
frequency, a known due date as `anchorDate`, amount).

## Example 5 — Runway analysis with a variable-spend estimate

"Will I have enough to cover rent this month?" / "when's my tightest week?"

1. Estimate everyday (non-recurring) spend so the projection isn't overly
   optimistic:
   `run-finance-query { query: { from: "transactions", filters: { lastMonths: 3, minCents: 1 }, metric: "sum" } }`
   → take the total, divide by ~90 days, round to whole cents:
   `dailyVariableSpendCents ≈ totalCents / 90`.
2. Run the projection:
   `get-runway { days: 30, dailyVariableSpendCents: <estimate> }`.
3. Check `negativeDates` and `minBalanceCents`/`minBalanceDate` in the
   result. If `minBalanceCents < 50000` (i.e. under $500) or any
   `negativeDates` exist, that's a pinch point — look at that day's `items`
   for the biggest contributor and warn the user by name and date
   ("Rent on the 1st drops you to $210, your lowest point this month").
4. Otherwise reassure them and mention the lowest point anyway ("You stay
   comfortably positive; lowest is $1,240 on the 3rd").
5. Offer `navigate { path: "/runway" }` so they can see the chart.

## Example 6 — Find and ignore internal transfers via a previewed rule

"Ignore all the transfers between my accounts" — a good case for the
rule-preview workflow before committing anything.

1. Find candidates first (read-only, no rule yet):
   `list-transactions { search: "transfer", datePreset: "last90", limit: 100 }`
   — skim `name`/`merchantName` for the transfer pattern (e.g. "ONLINE XFER",
   "TRANSFER TO SAVINGS").
2. Preview an inline (unsaved) rule before creating it:
   `apply-rules { rule: { matchName: "xfer", matchNameMode: "contains", setCategoryId: "cat_transfers" }, dryRun: true }`
   → check `matchedCount`. If a merchant name is ambiguous, tighten with
   `matchName: "online xfer"` or add `matchAccountId` and re-preview — inline
   preview mode never writes, so iterate freely.
3. Once the preview count looks right, create the rule for real:
   `create-rule { matchName: "xfer", matchNameMode: "contains", setCategoryId: "cat_transfers" }`
4. Apply to existing history (dry run, then real):
   `apply-rules { ruleId: "<new id>", dryRun: true }` → confirm counts with the
   user → `apply-rules { ruleId: "<new id>" }`.
5. `cat_transfers` is in the `ignored` category group, so these transactions
   are now automatically excluded from spend/income everywhere
   (`run-finance-query`, `spending-summary`, saved views) without needing
   `update-transaction { isIgnored: true }` on each one individually. Reserve
   the per-transaction `isIgnored` flag for one-off exclusions that don't fit
   a rule (e.g. a single refund you don't want counted, on a merchant you
   otherwise track normally).
6. Offer `navigate { path: "/rules" }` so the user can see the new rule, or
   `navigate { path: "/transactions?categoryId=cat_transfers" }` to review
   the now-categorized transactions.

## Example 7 — Set up budgets from my 3-month averages

"Set up a budget based on my spending" / "auto-fill my budget from history."

1. Get suggestions: `suggest-budget { lookbackMonths: 3 }` → returns per-category
   `{ categoryId, name, avgMonthlySpendCents, medianMonthlySpendCents,
   suggestedTargetCents, monthsWithData }`, sorted by suggested amount desc.
2. Present the suggested table to the user before writing anything (the
   `data-table` renderer works well: category / avg spend / suggested target).
   Skip categories with `monthsWithData: 0` — no signal to suggest from.
3. For each category the user confirms (or all of them, if they say
   "set them all up"), call `set-budget-line` once per category:
   ```
   set-budget-line { month: "2026-07", categoryId: "cat_groceries", targetCents: 45000 }
   ```
   Loop this for every confirmed row — there's no bulk-set action by design
   (keeps the action surface orthogonal; `set-budget-line` is one category at
   a time, same as `set-transaction-category`).
4. Confirm what was set ("Set 6 budgets totaling $2,340/mo") and offer
   `navigate { path: "/budgets" }` so the user can review and adjust.

Adjusting one target afterward, or removing a category from the budget
(`targetCents: 0`), is the same `set-budget-line` call — it's an upsert.

## Example 8 — Build an interactive what-if runway panel as an extension

"Make me a widget to play with runway scenarios" / "let me tune my daily
spend and see how it affects my balance."

This is a **full extension** (durable, reusable), not a one-off inline
control — the user wants to come back to it, so use `create-extension` rather
than `render-inline-extension`. See the "Interactive panels & generative UI"
section in `AGENTS.md` for the (c) vs (d) decision and a full HTML sketch.

Outline:
1. `create-extension { name: "Runway what-if", description: "Drag a daily spend estimate and see the recomputed 30-day runway.", content: "<html sketch>" }`
   — the HTML uses Alpine.js: a `<input type="range">` bound to
   `dailyVariableSpendCents`, and on `@input` calls
   `appAction('get-runway', { days: 30, dailyVariableSpendCents })`, rendering
   `minBalance`/`minBalanceDate`/`negativeDates` from the result.
2. No new action is needed — `get-runway` already accepts
   `dailyVariableSpendCents`, so the extension is a thin interactive frontend
   over an existing action.
3. Tell the user it's saved to their Extensions list and offer to open it:
   `show-extension-inline { extensionId }` or point them to `/extensions`.
4. If they want it pinned next to the Runway page itself, that's a slots
   question — see the `extension-points` skill (only if the app has declared
   a runway slot; otherwise it's a fine standalone extension).

## Example 9 — Set up a credit-card payment plan and verify funding

"I set up a payment plan with Example Card: $470/month at 7.25% APR for 60 months,
due the 17th, comes out of my Example Bank checking" — a first-known-terms create, not
a scan-then-confirm flow (unlike recurring detection).

1. Resolve account ids: `list-accounts` → find the Example Card credit card
   (`cardAccountId`, optional) and the Example Bank checking account (`payFromAccountId`,
   required).
2. Create the plan:
   ```
   create-payment-plan {
     name: "Example Card Visa settlement plan",
     cardAccountId: "acct_example_card",
     payFromAccountId: "acct_example_checking",
     paymentCents: 47000,
     dueDay: 17,
     aprBps: 725,
     termMonths: 60,
     originalBalanceCents: 2200000,
     merchantKey: "example card services"
   }
   ```
3. Link any existing matching payment history and refresh the balance:
   `match-plan-payments { planId: "<new id>" }` → report `matchedCount`.
4. Verify funding — this is the "$470 in Example Bank checking by the 17th" check:
   `list-payment-plans { status: "active" }` → find the new plan's `funding`
   field and read its **three-tier `fundingStatus`** (this is the model that
   replaced the old projected-only warning):
   - `fundingStatus === 'at_risk'` (equivalently the row's `warn: true`, when
     `householdCovered` is also false): income IS linked to Example Bank checking
     (`hasLinkedIncome: true`) yet it's still forecast short of $470 by the
     17th. A **real warning** — tell the user `shortfallCents` and the due date.
   - `fundingStatus === 'unverified'`: NO income recurring is linked to Example Bank
     checking, so the projection assumes zero income and can't be trusted.
     **Do NOT alarm.** Instead offer to link the user's paycheck recurring's
     `accountId` to Example Bank checking (`update-recurring { id, accountId }`), or ask
     which account the paycheck deposits into — then re-check (it should flip to
     `'ok'` or become a trustworthy `'at_risk'`).
   - `fundingStatus === 'ok'`: covered. `snapshotFundedNow === false` but
     `projectedFunded === true` (paycheck lands before the 17th) is the common,
     reassuring case — "currently short, but a paycheck lands on the 15th."
   - `householdCovered: true` (on an otherwise `at_risk`/`unverified` plan):
     the money EXISTS across the user's other accounts (`householdProjectedCents`),
     just not in Example Bank checking — tell them to **move $470 to Example Bank checking by the
     17th**, not that they're short. `funding.contributions` lists what was
     counted if the user wants the receipts.
5. For the ledger view, `get-runway { days: 30 }` folds the plan into the
   day-by-day ledger (flagged `kind: "plan"`, `critical: true`, `warn: true`
   only for a NET red alarm) and returns `planFundingWarnings` (red-only:
   `at_risk` with no household coverage) plus `planFundingNotes` (amber:
   `unverified` → link income, or `householdCovered` → move funds) — use these
   for "will I be able to make this payment" style questions.
6. Confirm what was created (payment, due day, APR, term, funding status) and
   offer `navigate { path: "/plans" }`.

Payment plans are CRITICAL bills — missing one is not an option — so they stay
visually prominent regardless of funding status; reserve alarming language for
`fundingStatus === 'at_risk'` with no household coverage (`warn: true`)
specifically — NOT an `'unverified'` plan (that's a "link your income" nudge),
a `householdCovered` plan (that's a "move funds" note), a merely-due-soon plan,
or a snapshot-short-but-projected-funded plan. Never treat them like an ordinary
subscription, and prefer `update-payment-plan` (not delete+recreate) when terms
change (due day moves, rate changes, balance corrections).

## Example 10 — Clean up duplicate Example Bank institutions end-to-end

"I think Example Bank is connected three times" — a common outcome of
re-linking the same bank login without update mode, plus a Rocket Money CSV
import creating manual accounts for the same numbers.

1. See what's actually there: `list-accounts { profile: "all" }` — look for
   more than one institution with a similar name (e.g. "Example Bank"
   Plaid-linked with real balances, a "Example Bank" manual institution
   with $0 balances from CSV import, and possibly an older Plaid Item that's
   a subset of the newest one).
2. Get the scan instead of eyeballing masks yourself:
   `get-merge-suggestions {}` → each suggestion gives a `targetAccountId`
   (prefers the Plaid-linked, most-recently-synced copy) and
   `sourceAccountIds` (the duplicates), grouped by matching mask + type.
3. Present the suggestions to the user — e.g. "Adv Plus Banking ··0537
   appears in 3 places → merge into Example Bank (synced)" — and get
   confirmation. Don't merge anything without the user seeing this first.
4. For each confirmed suggestion, loop `merge-accounts { fromAccountId, intoAccountId: targetAccountId }`
   over every id in `sourceAccountIds`. Report the aggregate
   `transactionsMoved`/`duplicatesRemoved` back to the user ("moved 1,204
   transactions, removed 38 duplicate rows").
5. If a suggestion carries `institutionFullyDuplicate` (every account at that
   institution was just merged away), offer to clean up the empty shell too:
   `remove-institution { institutionId: institutionFullyDuplicate.institutionId, keepDataAsManual: true }`
   — keeps nothing since it's already empty, just removes the redundant card.
   For an old duplicate Plaid Item that's still connected (not manual),
   confirm with the user first since `removeAtPlaid: true` (default) will
   call Plaid's `/item/remove` and free that connection slot — this is
   generally what you want for a genuinely-duplicate Item, since keeping it
   linked burns a limited trial/production connection for no reason.
6. Leftover manual accounts that aren't true duplicates (e.g. a history-only
   "Regular Savings ··1923" with no live Plaid counterpart) don't need
   merging — `move-account-to-institution` can still tuck them under the
   surviving institution's card for a tidier accounts list if the user wants
   that, but it's cosmetic, not required.
7. Confirm the end state with `list-accounts { profile: "all" }` again —
   each real account should now appear exactly once — and offer
   `navigate { path: "/accounts" }`.

If the user instead wants to add a business account that wasn't selected the
first time they linked a bank (not a duplicate-cleanup scenario), that's the
update-mode flow, not a merge: `plaid-create-link-token { institutionId }` →
after Link's `onSuccess` fires (no `public_token` in update mode) →
`plaid-refresh-accounts { institutionId }`.

## Example 11 — Represent a closed card as a manual account and track its payoff

"My Example Card card ··4607 is closed but I still owe $21,179.24 and pay it down
monthly — Plaid won't link it." Plaid can't onboard a closed/in-repayment
account, so represent it as a **manual account** and track the balance by hand
(a CSV row won't work — import accounts store a null balance and won't display
one; and a hand-made CSV's US `M/D/YYYY` dates are only tolerated for
transactions, not balances).

1. Check for an existing Example Card institution to reuse:
   `list-accounts { profile: "all" }` — if a manual "Example Card" already exists
   (e.g. from an earlier import), `create-manual-account` will reuse it by name.
2. Create the manual account at its real owed balance:
   ```
   create-manual-account {
     institutionName: "Example Card",
     accountName: "Visa ··4607 (closed)",
     mask: "4607",
     accountClass: "credit",
     subtype: "credit card",
     currentBalanceCents: 2117924   // amount OWED, positive
   }
   ```
   Returns `{ institutionId, accountId, balance }`. If it also reports
   `duplicatesRealInstitutionName: true`, a real Plaid-linked "Example Card" exists —
   mention the user can merge later (`get-merge-suggestions` / `merge-accounts`).
3. (Optional) Back a payoff plan with it so it's tracked as a CRITICAL bill:
   `create-payment-plan { name: "Example Card ··4607 payoff", cardAccountId: "<accountId>",
   payFromAccountId: "<Example Bank checking id>", paymentCents: 47000, dueDay: 17,
   currentBalanceCents: 2117924 }` — then follow Example 9's funding checks.
4. As the user pays it down, update the balance by hand:
   `set-account-balance { accountId: "<accountId>", currentBalanceCents: 2050000 }`
   — this bumps the manual institution's "updated" time; on /accounts the row
   shows a "manual" badge and "updated <relative>". This action **refuses
   Plaid-linked accounts** (their balance is sync-owned), so it's only for
   manual ones. Edit metadata with `update-manual-account`; remove it entirely
   with `delete-manual-account { accountId, confirmDelete: true }`.

## Example 12 — Import Recurly renewals and read the business runway

"Here's this month's upcoming-renewals export — how does the business look?"

1. Preview the import first (dryRun is the DEFAULT — never import blind):
   `import-recurly-renewals { csvText: <file contents>, accountId: "<business checking id>", payoutLagDays: 2, dryRun: true }`
   → report the summary: `parsed` billable renewals, `skippedFree` ($0
   free/dev plans, skipped), `created`/`updated`/`unchanged` (idempotent —
   re-importing a refreshed export updates rather than duplicates),
   `dateFrom`–`dateTo` (expected BANK dates = renewal + 2-day payout lag),
   and `totalProjected` dollars.
2. On confirmation, run it for real (`dryRun: false`), then offer
   `navigate { path: "/projections" }`.
3. Read the business runway WITH the projected income folded in:
   `get-runway { days: 30, profile: "business" }` — projected entries appear
   as `kind: "projected"` items with `estimate: true` on their expected bank
   dates, and the summary carries `projectedIncomeCents`. When reporting,
   caveat that number ("$4,820 of that is projected renewals — estimates,
   not promises") and check `planProjectedIncomeNotes` for any payment plan
   whose coverage RELIES on those renewals arriving.
4. One-off expectation instead of a CSV? "We expect $250 from renewals on
   the 15th" → `create-projected-entry { date: "YYYY-MM-15", amountCents:
   -25000, name: "Expected renewals", accountId: "<business checking id>" }`
   (income is NEGATIVE cents).
5. Weekly hygiene: `resolve-stale-projections { olderThanDays: 7, action:
   "missed" }` marks renewals that never landed (failed cards / churn) so
   the ledger stays honest; runway already stopped counting them at 7 days.

## Example 13 — "How's my dining trending?" (Spending explorer drill)

Trend-over-time questions about a category or merchant have a dedicated
interactive surface: the Spending explorer at `/spending` (chart + summary +
breakdown/transactions, every drill state URL-addressable). Prefer **act then
navigate** — compute the short answer, then drop the user into the scoped view.

1. Resolve the category: `list-categories` → "Dining" → e.g. `cat_dining`.
2. Get the trend numbers (month buckets, spend only):
   `run-finance-query { query: { from: "transactions", filters: { lastMonths: 6, categoryIds: ["cat_dining"], minCents: 1 }, groupBy: "month", metric: "sum", sort: "asc" } }`
   For a finer grain, `groupBy: "week"` now exists (ISO weeks; keys are the
   Monday `YYYY-MM-DD`; the sum of a range's weeks equals the sum of its days).
3. Comparison: run the same query for the immediately-preceding window
   (`dateFrom`/`dateTo` shifted back by the window length) and report the
   delta ("$1,240 over the last 6 months, up 18% vs the 6 before").
4. Navigate the user into the interactive drill state — same subset, same
   window, comparison overlay on:
   `navigate { path: "/spending?categoryId=cat_dining&from=2026-02-01&to=2026-07-31&granularity=month&compare=1" }`
   From there the user can tap a month bar to see its weeks, a week to see
   its days, and any merchant row to re-scope (`?merchant=...`). See the
   "Spending explorer (/spending)" section of AGENTS.md for the full URL
   grammar (`categoryId`, `merchant`, `accountId`, `from`/`to`,
   `granularity=day|week|month`, `compare=1`, `table=breakdown|transactions`).
5. One-off variant (the user just wants a number/picture in chat, no
   drilling): skip the navigate and render the step-2 rows with the
   `data-chart` renderer instead.

## Quick reference

- Manual (non-Plaid) accounts: `create-manual-account` at the real balance,
  `set-account-balance` to update by hand (refuses Plaid accounts). Right tool
  for a closed/in-repayment card, an external loan, or cash — not a CSV row.
- Spending only: `filters.minCents = 1`. Income only: `filters.maxCents = -1`.
- Transfers/loan payments are auto-excluded (`ignored` group) unless
  `includeIgnored: true`.
- `apply-rules` never touches locked transactions.
- Inline one-off answers: prefer the built-in `data-chart` / `data-table` /
  `data-insights` chat renderers over creating throwaway saved views.
- Recurring bills/subscriptions/income: `detect-recurring` (scan, read-only)
  → `create-recurring` (confirmed candidates only). `get-runway` for cashflow
  projections; pass `dailyVariableSpendCents` for a realistic picture.
- Budgets: `get-budget` for the current-month picture, `suggest-budget` for
  history-based targets, `set-budget-line` (upsert; `targetCents<=0` deletes)
  one category at a time, `copy-budget-forward` to roll a month's targets into
  the next, `budget-history` for the 12-month spend-vs-target trend.
- Transient chat controls: `render-inline-extension`. Durable, reusable
  mini-apps: `create-extension`. Both use the same `appAction`/`extensionData`
  bridge — see "Interactive panels & generative UI" in `AGENTS.md`.
- Payment plans are CRITICAL, never-miss bills: `create-payment-plan` directly
  from known terms (no scan-then-confirm), `match-plan-payments` to link real
  payments and refresh the balance. Read the three-tier `funding.fundingStatus`:
  only `'at_risk'` with no household coverage (row `warn: true`) is a real
  warning. `'unverified'` (no income linked to the pay-from account) is a
  NUDGE — offer to link the paycheck recurring's `accountId` to that account
  (`update-recurring { id, accountId }`), don't alarm. `householdCovered: true`
  is a "move $X to <account> by <date>" note — the money exists across
  accounts. `get-runway` splits these: `planFundingWarnings` is red-only,
  `planFundingNotes` carries the amber unverified/household-covered items. When
  the user reports income ("I get paid $X every 2 weeks"), set the deposit
  `accountId` on the income recurring so plan projections become trustworthy.
- Adding accounts at an already-linked bank: update mode
  (`plaid-create-link-token { institutionId }` → `plaid-refresh-accounts`),
  never a fresh connection. Duplicate accounts: `get-merge-suggestions` →
  confirm with the user → `merge-accounts`. Dead/duplicate connections:
  `remove-institution` (always confirm first, especially `keepDataAsManual: false`).
