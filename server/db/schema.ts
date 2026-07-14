/**
 * Finance domain schema.
 *
 * Portable across SQLite (local) and Postgres (Railway) via the framework
 * helpers — never import from drizzle-orm/{sqlite,pg}-core directly.
 *
 * Money is stored as signed INTEGER minor units (cents) to avoid float error.
 * Plaid sign convention is preserved: positive = money OUT of the account
 * (spending), negative = money IN (income/refund). Normalize at the edges.
 */
import { table, text, integer, now } from "@agent-native/core/db/schema";

/** A connected financial institution (≈ one Plaid Item). */
export const institutions = table("fp_institutions", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  plaidItemId: text("plaid_item_id").notNull(),
  plaidInstitutionId: text("plaid_institution_id"),
  name: text("name").notNull(),
  // TODO(security): encrypt at rest before any shared/hosted deployment.
  accessToken: text("access_token").notNull(),
  syncCursor: text("sync_cursor"),
  status: text("status").notNull().default("connected"),
  lastSyncedAt: text("last_synced_at"),
  /** Profile ('personal' | 'business') applied to newly discovered accounts. */
  defaultProfile: text("default_profile").notNull().default("personal"),
  createdAt: text("created_at").notNull().default(now()),
});

/**
 * An account within an institution (≈ one Plaid Account). `profile` is the
 * SOURCE OF TRUTH for which profile an account belongs to — account-level
 * because a single bank login (one institution) can hold both personal and
 * business accounts (e.g. Example Bank). `isManual`/`manualAccountType`
 * support Rocket Money CSV-imported accounts that have no Plaid item.
 */
export const accounts = table("fp_accounts", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  institutionId: text("institution_id").notNull(),
  plaidAccountId: text("plaid_account_id").notNull(),
  name: text("name"),
  officialName: text("official_name"),
  /**
   * User-set friendly nickname (app-side metadata). Nullable; when null the
   * institution-provided `name` is shown. A Plaid sync NEVER touches this
   * column (finance-sync's account upsert omits it), so nicknames survive
   * syncs for both Plaid-linked and manual accounts. Set via rename-account;
   * consumers get COALESCE(display_name, name) as the display name.
   */
  displayName: text("display_name"),
  mask: text("mask"),
  type: text("type"),
  subtype: text("subtype"),
  currentBalanceCents: integer("current_balance_cents"),
  availableBalanceCents: integer("available_balance_cents"),
  isoCurrency: text("iso_currency"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  profile: text("profile").notNull().default("personal"),
  isManual: integer("is_manual", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now()),
});

/** A single transaction (≈ one Plaid Transaction). */
export const transactions = table("fp_transactions", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  accountId: text("account_id").notNull(),
  institutionId: text("institution_id").notNull(),
  plaidTransactionId: text("plaid_transaction_id").notNull(),
  date: text("date"),
  authorizedDate: text("authorized_date"),
  name: text("name"),
  merchantName: text("merchant_name"),
  amountCents: integer("amount_cents").notNull(),
  isoCurrency: text("iso_currency"),
  pending: integer("pending", { mode: "boolean" }).notNull().default(false),
  pfcPrimary: text("pfc_primary"),
  pfcDetailed: text("pfc_detailed"),
  categoryId: text("category_id"),
  categoryLocked: integer("category_locked", { mode: "boolean" })
    .notNull()
    .default(false),
  note: text("note"),
  rawPlaid: text("raw_plaid"),
  recurringId: text("recurring_id"),
  isIgnored: integer("is_ignored", { mode: "boolean" }).notNull().default(false),
  isTaxDeductible: integer("is_tax_deductible", { mode: "boolean" }).notNull().default(false),
  /** Linked payment plan when this row is a matched plan payment (see payment-plans.ts). */
  paymentPlanId: text("payment_plan_id"),
  /** Denormalized from the owning account, for query speed. */
  profile: text("profile").notNull().default("personal"),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});

/**
 * User-facing spending categories. `categoryGroup` controls how analytics
 * treat member transactions: 'expenses' (spend), 'earnings' (income), or
 * 'ignored' (transfers/loan payments — excluded from spend & income).
 * NOTE: column is `category_group` because `group` is a SQL keyword.
 */
export const categories = table("fp_categories", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  name: text("name").notNull(),
  categoryGroup: text("category_group").notNull().default("expenses"),
  icon: text("icon"),
  color: text("color"),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  profile: text("profile").notNull().default("personal"),
  createdAt: text("created_at").notNull().default(now()),
});

/**
 * Auto-categorization rules. Applied by ascending priority (lower runs
 * first); the first rule whose match_* conditions all pass wins.
 */
export const rules = table("fp_rules", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  priority: integer("priority").notNull().default(100),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  matchName: text("match_name"),
  matchNameMode: text("match_name_mode"), // 'contains' | 'exact' | 'regex'
  /** Optional contains-none term: if set, name/merchant must NOT contain it (case-insensitive). */
  matchNameExclude: text("match_name_exclude"),
  matchAccountId: text("match_account_id"),
  matchMinCents: integer("match_min_cents"),
  matchMaxCents: integer("match_max_cents"),
  setCategoryId: text("set_category_id"),
  setMerchantName: text("set_merchant_name"),
  profile: text("profile").notNull().default("personal"),
  createdAt: text("created_at").notNull().default(now()),
});

/**
 * Agent-craftable saved views: durable charts/tables/metrics the UI renders
 * on /views. `config` is JSON: { query, chart?, table?, metric? } validated
 * by the saved-view actions (see server/lib/finance-query.ts).
 */
export const savedViews = table("fp_saved_views", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").notNull(), // 'chart' | 'table' | 'metric'
  config: text("config").notNull(), // JSON
  position: integer("position").notNull().default(0),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
  profile: text("profile").notNull().default("personal"),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});

/**
 * Recurring bills/subscriptions/income, either agent-detected or manually
 * created. `merchantKey` is the normalized match pattern (see
 * normalizeMerchantKey in server/lib/recurring.ts) used to link new
 * transactions to a recurring during sync. `anchorDate` is a known occurrence
 * date; future occurrences are derived from it + `frequency`.
 */
export const recurring = table("fp_recurring", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  name: text("name").notNull(),
  merchantKey: text("merchant_key"),
  kind: text("kind").notNull(), // 'bill' | 'subscription' | 'income'
  frequency: text("frequency").notNull(), // 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'
  anchorDate: text("anchor_date"),
  avgAmountCents: integer("avg_amount_cents"),
  lastAmountCents: integer("last_amount_cents"),
  lastSeenDate: text("last_seen_date"),
  accountId: text("account_id"),
  categoryId: text("category_id"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  autoDetected: integer("auto_detected", { mode: "boolean" }).notNull().default(false),
  notes: text("notes"),
  profile: text("profile").notNull().default("personal"),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});

/**
 * Generic app settings store, keyed per-owner. Currently used for
 * `active_profile` ('personal' | 'business') — which profile the agent/UI is
 * currently scoped to by default. Logical key is (owner_email, key); `id` is
 * a deterministic `${ownerEmail}:${key}` string so upserts are select-then-write
 * like the rest of this schema (see fp_settings_owner_key_idx in migrations).
 */
export const settings = table("fp_settings", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  key: text("key").notNull(),
  value: text("value"),
});

/**
 * Monthly budget targets, one row per (profile, month, category). `month` is
 * `YYYY-MM`; `targetCents` is a positive spend target for that category that
 * month. Rows are upserted by the set-budget-line action (targetCents<=0
 * deletes the line); see fp_budget_lines_unique_idx in migrations for the
 * (owner_email, profile, month, category_id) uniqueness key.
 */
export const budgetLines = table("fp_budget_lines", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  profile: text("profile").notNull().default("personal"),
  month: text("month").notNull(),
  categoryId: text("category_id").notNull(),
  targetCents: integer("target_cents").notNull(),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});

/**
 * Projected (expected but not yet received) income/outflow entries — a
 * Quicken-style scheduled ledger of PROBABILISTIC future cash events, most
 * commonly upcoming SaaS subscription renewals imported from a Recurly CSV
 * export. `date` is the expected BANK date (renewal date + payout lag, e.g.
 * Recurly bills then Stripe pays out ~2 days later). `amount_cents` follows
 * the Plaid sign convention: income is NEGATIVE. `external_key` is the
 * idempotency key for imports ('recurly:<subscriptionId>:<renewalDate>');
 * manual entries get a generated 'manual:<id>' fallback so the column stays
 * NOT NULL and the (owner_email, external_key) unique index is portable
 * across dialects. `status` lifecycle: 'projected' → 'received' | 'missed' |
 * 'canceled'. Past-dated 'projected' rows older than 7 days are excluded from
 * runway math automatically (stale estimates) but stay visible on
 * /projections as past due for manual resolution. `metadata` is JSON
 * (planId/planName/customerName/urls from the import source).
 */
export const projectedEntries = table("fp_projected_entries", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  profile: text("profile").notNull().default("personal"),
  /** Target account the money is expected to hit (nullable, UI encourages). */
  accountId: text("account_id"),
  /** Expected BANK date (renewal date + payout lag), YYYY-MM-DD. */
  date: text("date").notNull(),
  /** Signed cents, Plaid convention: income NEGATIVE, outflow positive. */
  amountCents: integer("amount_cents").notNull(),
  name: text("name").notNull(),
  source: text("source").notNull(), // 'manual' | 'recurly-import' | 'api'
  /** Idempotency key; NOT NULL with 'manual:<id>' fallback for manual rows. */
  externalKey: text("external_key").notNull(),
  status: text("status").notNull().default("projected"), // 'projected' | 'received' | 'missed' | 'canceled'
  notes: text("notes"),
  /** JSON: { planId?, planName?, customerName?, recurlyAccountUrl?, recurlyRecordUrl? } */
  metadata: text("metadata"),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});

/**
 * Fixed payoff plans negotiated with a creditor (e.g. a credit-card hardship
 * plan): fixed monthly payment, fixed lower APR, fixed term, due a specific
 * day-of-month, paid FROM a specific checking account. Treated as CRITICAL
 * never-miss bills — see server/lib/payment-plans.ts for amortization,
 * funding checks, and payment matching. `current_balance_cents` declines
 * toward zero like a loan as matched payments are applied.
 */
export const paymentPlans = table("fp_payment_plans", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  profile: text("profile").notNull().default("personal"),
  name: text("name").notNull(),
  /** The credit card / loan account being paid down (optional link). */
  cardAccountId: text("card_account_id"),
  /** The funding account the payment MUST come from (conceptually required). */
  payFromAccountId: text("pay_from_account_id"),
  paymentCents: integer("payment_cents").notNull(),
  /** Day of month (1-31) the payment is due; clamped for short months. */
  dueDay: integer("due_day").notNull(),
  /** Annual rate in basis points, e.g. 725 = 7.25%. */
  aprBps: integer("apr_bps"),
  termMonths: integer("term_months"),
  startDate: text("start_date"),
  originalBalanceCents: integer("original_balance_cents"),
  currentBalanceCents: integer("current_balance_cents"),
  /** Normalized merchant match pattern used to auto-link payment transactions. */
  merchantKey: text("merchant_key"),
  status: text("status").notNull().default("active"), // 'active' | 'paid_off' | 'closed'
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});
