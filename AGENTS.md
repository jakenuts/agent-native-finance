# Finance - Agent Guide

Finance is an Agent Native app for personal and business cash management. It
syncs banking data through Plaid, imports optional CSV history, categorizes
transactions, tracks recurring obligations, models payment plans, and projects
runway from real balances plus scheduled and projected cash events.

Chat is the primary surface. Durable output belongs in saved views on `/views`.
Use app actions for all reads and writes so the UI and agent stay on the same
contract.

## Core Rules

- Store money as signed integer cents (`amount_cents`). Plaid convention:
  positive = money out, negative = money in.
- Convert cents to dollars only for display.
- Use Drizzle query builders or parameterized SQL. Do not concatenate user
  input into SQL.
- Keep durable state in SQL. Do not add tracked runtime data files.
- Secrets belong in setup scoped secrets, local `.env`, GitHub Actions secrets,
  or deploy-provider env vars. Never commit real values.
- Optional providers must work as optional providers. The app should start with
  no Plaid or Recurly keys configured.

## Data Model

Finance domain tables use the `fp_` prefix:

| Table | Purpose |
| --- | --- |
| `fp_institutions` | Connected Plaid items or manual institutions |
| `fp_accounts` | Bank, card, loan, and manual accounts; `profile` is the source of truth |
| `fp_transactions` | Ledger rows, categories, notes, Plaid PFC data, profile snapshot |
| `fp_categories` | Profile-scoped categories grouped as `expenses`, `earnings`, or `ignored` |
| `fp_rules` | Profile-scoped auto-categorization rules |
| `fp_saved_views` | Profile-scoped durable charts, tables, and metrics |
| `fp_recurring` | Recurring bills, subscriptions, and income |
| `fp_budget_lines` | Monthly category targets |
| `fp_payment_plans` | Critical fixed payoff/payment plans |
| `fp_projected_entries` | Expected future cash events used by runway |
| `fp_settings` | Per-owner settings such as active profile |

## Profiles

The app supports `personal`, `business`, and combined `all` views. Every
profile-scoped action defaults to the active profile unless a `profile`
override is passed.

- Use `get-active-profile` before answering ambiguous finance questions.
- Pass `profile: "personal" | "business" | "all"` rather than switching the
  active profile for one-off analysis.
- Use `set-account-profile` to move one account and its transactions between
  profiles.
- New profile-scoped mutations stamp the active profile unless an explicit
  profile is supplied.
- After adding a profile-scoped table or analytical action, run
  `pnpm action profile-audit '{}'` and address any violations.

## Action Groups

Common read actions:

- `finance-summary`
- `list-accounts`
- `list-transactions`
- `get-transaction`
- `run-finance-query`
- `spending-summary`
- `list-categories`
- `list-rules`
- `list-recurring`
- `upcoming-bills`
- `get-runway`
- `list-payment-plans`
- `list-projected-entries`
- `list-projection-sources`
- `list-saved-views`

Common write actions:

- `plaid-sync`, `refresh-balances`, `plaid-create-link-token`,
  `plaid-exchange-public-token`
- `import-rm-csv`
- `create-category`, `update-category`, `delete-category`
- `create-rule`, `update-rule`, `delete-rule`, `apply-rules`
- `set-transaction-category`, `bulk-update-transactions`,
  `bulk-update-transactions-by-filter`, `update-transaction`
- `create-recurring`, `update-recurring`, `delete-recurring`
- `create-payment-plan`, `update-payment-plan`, `delete-payment-plan`,
  `match-plan-payments`
- `create-projected-entry`, `update-projected-entry`,
  `delete-projected-entry`, `import-recurly-renewals`,
  `sync-recurly-renewals`, `resolve-stale-projections`
- `create-saved-view`, `update-saved-view`, `delete-saved-view`,
  `pin-saved-view`

High-blast-radius bulk actions default to dry runs where possible. Always
preview counts before applying filter-based updates, rule application, imports,
or deletes.

## Categorization

Categorization precedence is:

1. `category_locked` manual choice
2. Enabled rules, ordered by ascending priority
3. Plaid PFC mapping in `server/lib/categorize.ts`
4. Uncategorized

Create a rule for repeated merchant/category fixes. Use one-off transaction
updates only for exceptions.

## Recurring, Plans, And Runway

- Prefer recurring entries for known bills, subscriptions, and income.
- Use `detect-recurring` as a read-only scan, show candidates, then create only
  the entries the user confirms.
- Payment plans are critical obligations. Include them in every monthly-bills
  and runway answer.
- For runway questions, estimate variable spend from recent transaction history
  with `run-finance-query`, then call `get-runway`.
- When a payment plan shows `fundingStatus: "unverified"`, link recurring
  income or projected income to the pay-from account before treating it as a
  true shortfall.

## Projection Sources

Projected income can come from:

- Manual expected cash events through `create-projected-entry`
- Recurly renewal CSV import through `import-recurly-renewals`
- Optional Recurly API automation through `sync-recurly-renewals`

Call `list-projection-sources` before assuming Recurly API automation is
configured. Recurly CSV imports use this generic header:

```text
renewalDateUtc,accountId,subscriptionId,planId,planName,expectedAmount,currency,status,customerId,customerName,customerTier,recurlyAccountUrl,recurlyRecordUrl
```

Projected entries are estimates. When reporting runway, mention how much of the
projection depends on projected income.

## Application State

- `view-screen` returns the current route, selected context, and active profile.
- `navigate` writes UI navigation commands.
- Use route state before acting on phrases like "this transaction" or "this
  account".

## Template Setup

Provider setup is registered through `server/plugins/onboarding.ts`:

- Plaid: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`,
  `PLAID_WEBHOOK_URL`, `PLAID_REDIRECT_URI`
- Recurly API: `RECURLY_API_KEY`, optional `RECURLY_SUBDOMAIN`

Deployment-level variables include `DATABASE_URL`, `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, `OAUTH_STATE_SECRET`, `A2A_SECRET`,
`SECRETS_ENCRYPTION_KEY`, and an LLM provider key such as
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

For single-tenant production installs, set `FINANCE_BLOCK_SIGNUP=true` after
the owner account exists to block new email/password signups.

## Validation

Run the checks that cover your change:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm action profile-audit '{}'
pnpm action db-check-scoping '{}'
```

For provider or projection changes, also run:

```bash
pnpm action list-projection-sources '{}'
```

Keep the app usable without optional provider keys. Use `FINANCE_DISABLE_SCHEDULER=true`
for one-off action checks and CI-style validation.

## Skills

Use `.agents/skills/finance-analytics/SKILL.md` for worked action sequences
around categorization, analytics, saved views, recurring bills, budgets,
payment plans, and runway.
