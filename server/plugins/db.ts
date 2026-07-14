/**
 * Additive, idempotent migrations for Finance domain tables, applied at
 * startup. Portable SQL (text/integer only) so it runs on SQLite, PGlite,
 * and Postgres alike. STRICTLY ADDITIVE — never drop/rename (see docs).
 */
import { runMigrations } from "@agent-native/core/db";
import {
  PFC_DETAILED_TO_CATEGORY,
  PFC_PRIMARY_TO_CATEGORY,
  SYSTEM_CATEGORIES,
  SYSTEM_CATEGORIES_BUSINESS,
} from "../lib/categorize.js";
import { ownerEmail } from "../lib/owner.js";

/** Escape a string literal for embedding in portable SQL. */
function sq(value: string): string {
  return value.replace(/'/g, "''");
}

const SEED_OWNER = sq(ownerEmail());
const SEED_AT = new Date().toISOString();

/** Idempotent system-category seed (deterministic ids + ON CONFLICT). */
const seedCategoriesSql = `INSERT INTO fp_categories
  (id, owner_email, name, category_group, icon, color, is_system, created_at)
VALUES
${SYSTEM_CATEGORIES.map(
  (c) =>
    `  ('${c.id}', '${SEED_OWNER}', '${sq(c.name)}', '${c.group}', '${c.icon}', '${c.color}', 1, '${SEED_AT}')`,
).join(",\n")}
ON CONFLICT (id) DO NOTHING`;

/** Three starter saved views so /views isn't empty on first run. */
const STARTER_VIEWS = [
  {
    id: "sv_starter_category_donut",
    name: "Spending by category (this month)",
    description: "Where this month's money went, by category.",
    kind: "chart",
    pinned: 1,
    position: 0,
    config: {
      query: {
        from: "transactions",
        filters: { month: "current", minCents: 1 },
        groupBy: "category",
        metric: "sum",
        sort: "desc",
      },
      chart: { type: "donut" },
    },
  },
  {
    id: "sv_starter_spend_trend",
    name: "6-month spending trend",
    description: "Total spend per month over the last six months.",
    kind: "chart",
    pinned: 1,
    position: 1,
    config: {
      query: {
        from: "transactions",
        filters: { lastMonths: 6, minCents: 1 },
        groupBy: "month",
        metric: "sum",
        sort: "asc",
      },
      chart: { type: "area", yLabel: "Spend" },
    },
  },
  {
    id: "sv_starter_top_merchants",
    name: "Top merchants (this month)",
    description: "Biggest merchants by spend this month.",
    kind: "table",
    pinned: 0,
    position: 2,
    config: {
      query: {
        from: "transactions",
        filters: { month: "current", minCents: 1 },
        groupBy: "merchant",
        metric: "sum",
        sort: "desc",
        limit: 15,
      },
      table: {},
    },
  },
];

const seedViewsSql = `INSERT INTO fp_saved_views
  (id, owner_email, name, description, kind, config, position, is_pinned, created_at, updated_at)
VALUES
${STARTER_VIEWS.map(
  (v) =>
    `  ('${v.id}', '${SEED_OWNER}', '${sq(v.name)}', '${sq(v.description)}', '${v.kind}', '${sq(JSON.stringify(v.config))}', ${v.position}, ${v.pinned}, '${SEED_AT}', '${SEED_AT}')`,
).join(",\n")}
ON CONFLICT (id) DO NOTHING`;

/**
 * One-time backfill: apply the static PFC → category mapping to transactions
 * that existed before categorization shipped. Generated from the same maps
 * sync uses (categorize.ts); all values are code constants, never user input.
 */
const catIdByName = new Map(SYSTEM_CATEGORIES.map((c) => [c.name, c.id]));
const detailedCases = Object.entries(PFC_DETAILED_TO_CATEGORY)
  .filter(([, name]) => catIdByName.has(name))
  .map(([code, name]) => `WHEN pfc_detailed = '${code}' THEN '${catIdByName.get(name)}'`);
const primaryCases = Object.entries(PFC_PRIMARY_TO_CATEGORY)
  .filter(([, name]) => catIdByName.has(name))
  .map(([code, name]) => `WHEN pfc_primary = '${code}' THEN '${catIdByName.get(name)}'`);
const backfillCategoriesSql = `UPDATE fp_transactions SET category_id = CASE
${[...detailedCases, ...primaryCases].map((c) => `  ${c}`).join("\n")}
  ELSE NULL END
WHERE category_id IS NULL AND category_locked = 0`;

/** Idempotent business-profile system-category seed (v22). */
const seedBusinessCategoriesSql = `INSERT INTO fp_categories
  (id, owner_email, name, category_group, icon, color, is_system, profile, created_at)
VALUES
${SYSTEM_CATEGORIES_BUSINESS.map(
  (c) =>
    `  ('${c.id}', '${SEED_OWNER}', '${sq(c.name)}', '${c.group}', '${c.icon}', '${c.color}', 1, 'business', '${SEED_AT}')`,
).join(",\n")}
ON CONFLICT (id) DO NOTHING`;

export default runMigrations(
  [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS fp_institutions (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        plaid_item_id TEXT NOT NULL,
        plaid_institution_id TEXT,
        name TEXT NOT NULL,
        access_token TEXT NOT NULL,
        sync_cursor TEXT,
        status TEXT NOT NULL DEFAULT 'connected',
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 2,
      sql: `CREATE TABLE IF NOT EXISTS fp_accounts (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        institution_id TEXT NOT NULL,
        plaid_account_id TEXT NOT NULL,
        name TEXT,
        official_name TEXT,
        mask TEXT,
        type TEXT,
        subtype TEXT,
        current_balance_cents INTEGER,
        available_balance_cents INTEGER,
        iso_currency TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 3,
      sql: `CREATE TABLE IF NOT EXISTS fp_transactions (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        account_id TEXT NOT NULL,
        institution_id TEXT NOT NULL,
        plaid_transaction_id TEXT NOT NULL,
        date TEXT,
        authorized_date TEXT,
        name TEXT,
        merchant_name TEXT,
        amount_cents INTEGER NOT NULL,
        iso_currency TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        pfc_primary TEXT,
        pfc_detailed TEXT,
        category_id TEXT,
        raw_plaid TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 4,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS fp_tx_plaid_id_idx ON fp_transactions (plaid_transaction_id)`,
    },
    {
      version: 5,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS fp_acct_plaid_id_idx ON fp_accounts (plaid_account_id)`,
    },
    {
      version: 6,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS fp_inst_item_id_idx ON fp_institutions (plaid_item_id)`,
    },
    {
      version: 7,
      sql: `CREATE TABLE IF NOT EXISTS fp_categories (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        name TEXT NOT NULL,
        category_group TEXT NOT NULL DEFAULT 'expenses',
        icon TEXT,
        color TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 8,
      sql: `CREATE TABLE IF NOT EXISTS fp_rules (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        match_name TEXT,
        match_name_mode TEXT,
        match_account_id TEXT,
        match_min_cents INTEGER,
        match_max_cents INTEGER,
        set_category_id TEXT,
        set_merchant_name TEXT,
        created_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 9,
      sql: `ALTER TABLE fp_transactions ADD COLUMN category_locked INTEGER NOT NULL DEFAULT 0`,
    },
    {
      version: 10,
      sql: `ALTER TABLE fp_transactions ADD COLUMN note TEXT`,
    },
    {
      version: 11,
      sql: `CREATE TABLE IF NOT EXISTS fp_saved_views (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL,
        config TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    { version: 12, sql: seedCategoriesSql },
    { version: 13, sql: seedViewsSql },
    { version: 14, sql: backfillCategoriesSql },
    {
      version: 15,
      sql: `CREATE TABLE IF NOT EXISTS fp_recurring (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        name TEXT NOT NULL,
        merchant_key TEXT,
        kind TEXT NOT NULL,
        frequency TEXT NOT NULL,
        anchor_date TEXT,
        avg_amount_cents INTEGER,
        last_amount_cents INTEGER,
        last_seen_date TEXT,
        account_id TEXT,
        category_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        auto_detected INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 16,
      sql: `ALTER TABLE fp_transactions ADD COLUMN recurring_id TEXT`,
    },
    {
      version: 17,
      sql: `ALTER TABLE fp_transactions ADD COLUMN is_ignored INTEGER NOT NULL DEFAULT 0`,
    },
    {
      version: 18,
      sql: `ALTER TABLE fp_transactions ADD COLUMN is_tax_deductible INTEGER NOT NULL DEFAULT 0`,
    },
    // --- Profiles (Personal/Business) ---------------------------------
    {
      version: 19,
      name: "profiles-add-columns",
      // IF NOT EXISTS makes each ALTER idempotent (Postgres natively; SQLite
      // via the migration runner's duplicate-column-error swallowing) — this
      // migration previously partially applied across dev-server HMR
      // restarts, so a plain re-run without IF NOT EXISTS would fail forever.
      sql: `ALTER TABLE fp_accounts ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE fp_accounts ADD COLUMN IF NOT EXISTS is_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fp_transactions ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE fp_recurring ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE fp_rules ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE fp_categories ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE fp_saved_views ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE fp_institutions ADD COLUMN IF NOT EXISTS default_profile TEXT NOT NULL DEFAULT 'personal'`,
    },
    {
      version: 20,
      name: "profiles-settings-table",
      sql: `CREATE TABLE IF NOT EXISTS fp_settings (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT
      )`,
    },
    {
      version: 21,
      name: "profiles-settings-unique-idx",
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS fp_settings_owner_key_idx ON fp_settings (owner_email, key)`,
    },
    // Existing system categories predate profiles — they're all personal.
    {
      version: 22,
      name: "profiles-backfill-system-categories-personal",
      sql: `UPDATE fp_categories SET profile = 'personal' WHERE is_system = 1`,
    },
    { version: 23, name: "profiles-seed-business-categories", sql: seedBusinessCategoriesSql },
    // Our hand-written CREATE TABLEs declared boolean-ish columns as INTEGER, but the
    // framework's integer({mode:"boolean"}) maps to a real Postgres BOOLEAN — Drizzle
    // writes true/false and Postgres rejects them against bigint. Convert on Postgres;
    // SQLite stores booleans as integers natively, so it's a no-op there.
    {
      version: 24,
      name: "postgres-boolean-column-types",
      sql: {
        postgres: `ALTER TABLE fp_accounts ALTER COLUMN is_active DROP DEFAULT, ALTER COLUMN is_active TYPE boolean USING is_active::int::boolean, ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE fp_accounts ALTER COLUMN is_manual DROP DEFAULT, ALTER COLUMN is_manual TYPE boolean USING is_manual::int::boolean, ALTER COLUMN is_manual SET DEFAULT false;
ALTER TABLE fp_transactions ALTER COLUMN pending DROP DEFAULT, ALTER COLUMN pending TYPE boolean USING pending::int::boolean, ALTER COLUMN pending SET DEFAULT false;
ALTER TABLE fp_transactions ALTER COLUMN category_locked DROP DEFAULT, ALTER COLUMN category_locked TYPE boolean USING category_locked::int::boolean, ALTER COLUMN category_locked SET DEFAULT false;
ALTER TABLE fp_transactions ALTER COLUMN is_ignored DROP DEFAULT, ALTER COLUMN is_ignored TYPE boolean USING is_ignored::int::boolean, ALTER COLUMN is_ignored SET DEFAULT false;
ALTER TABLE fp_transactions ALTER COLUMN is_tax_deductible DROP DEFAULT, ALTER COLUMN is_tax_deductible TYPE boolean USING is_tax_deductible::int::boolean, ALTER COLUMN is_tax_deductible SET DEFAULT false;
ALTER TABLE fp_categories ALTER COLUMN is_system DROP DEFAULT, ALTER COLUMN is_system TYPE boolean USING is_system::int::boolean, ALTER COLUMN is_system SET DEFAULT false;
ALTER TABLE fp_rules ALTER COLUMN is_enabled DROP DEFAULT, ALTER COLUMN is_enabled TYPE boolean USING is_enabled::int::boolean, ALTER COLUMN is_enabled SET DEFAULT true;
ALTER TABLE fp_saved_views ALTER COLUMN is_pinned DROP DEFAULT, ALTER COLUMN is_pinned TYPE boolean USING is_pinned::int::boolean, ALTER COLUMN is_pinned SET DEFAULT false;
ALTER TABLE fp_recurring ALTER COLUMN is_active DROP DEFAULT, ALTER COLUMN is_active TYPE boolean USING is_active::int::boolean, ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE fp_recurring ALTER COLUMN auto_detected DROP DEFAULT, ALTER COLUMN auto_detected TYPE boolean USING auto_detected::int::boolean, ALTER COLUMN auto_detected SET DEFAULT false`,
        sqlite: `SELECT 1`,
      },
    },
    // --- Budgets ---------------------------------------------------------
    {
      version: 25,
      name: "budgets-table",
      sql: `CREATE TABLE IF NOT EXISTS fp_budget_lines (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'personal',
        month TEXT NOT NULL,
        category_id TEXT NOT NULL,
        target_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 26,
      name: "budgets-unique-idx",
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS fp_budget_lines_unique_idx ON fp_budget_lines (owner_email, profile, month, category_id)`,
    },
    // --- Payment plans (credit-card payoff plans) -------------------------
    {
      version: 27,
      name: "payment-plans-table",
      sql: `CREATE TABLE IF NOT EXISTS fp_payment_plans (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'personal',
        name TEXT NOT NULL,
        card_account_id TEXT,
        pay_from_account_id TEXT,
        payment_cents INTEGER NOT NULL,
        due_day INTEGER NOT NULL,
        apr_bps INTEGER,
        term_months INTEGER,
        start_date TEXT,
        original_balance_cents INTEGER,
        current_balance_cents INTEGER,
        merchant_key TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
    },
    {
      version: 28,
      name: "transactions-add-payment-plan-id",
      sql: `ALTER TABLE fp_transactions ADD COLUMN IF NOT EXISTS payment_plan_id TEXT`,
    },
    // --- Rules v2 (regex match mode + exclude term) -----------------------
    {
      version: 29,
      name: "rules-add-match-name-exclude",
      sql: `ALTER TABLE fp_rules ADD COLUMN IF NOT EXISTS match_name_exclude TEXT`,
    },
    // --- Framework table the retry job polls but never creates ------------
    // @agent-native/core's pending-tasks-retry-job SELECTs from
    // integration_pending_tasks on an interval, but the framework only creates
    // the table lazily on the first webhook-integration WRITE (see
    // dist/integrations/pending-tasks-store.js). This app has no chat
    // integrations, so the table never exists and the POSTGRES SERVER logs an
    // ERROR for every poll (the app-side error is swallowed — the spam is in
    // the database service logs). DDL mirrors the framework's own; drop this
    // migration if the framework ever ensures the table in its retry job.
    {
      version: 30,
      name: "framework-integration-pending-tasks",
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS integration_pending_tasks (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  org_id TEXT,
  status TEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  external_event_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_status_created ON integration_pending_tasks(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_tasks_event_key ON integration_pending_tasks(platform, external_event_key)`,
        sqlite: `CREATE TABLE IF NOT EXISTS integration_pending_tasks (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  org_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  external_event_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_status_created ON integration_pending_tasks(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_tasks_event_key ON integration_pending_tasks(platform, external_event_key)`,
      },
    },
    // --- More framework-probed tables (same class as v30) ------------------
    // Core probes these without creating them: mcp-client/workspace-servers
    // reads Dispatch's workspace_resources(+grants) on agent runs (gracefully
    // tolerated app-side, but Postgres logs an ERROR per probe), and the
    // extensions feature's tables (`tools`, `tool_shares` — DDL copied
    // verbatim from @agent-native/core dist/extensions/schema.js constants
    // EXTENSIONS_CREATE_SQL[_PG]) are needed for agent-built extension panels
    // anyway. workspace_resources columns derive from the only consumer's
    // SELECTs (dist/mcp-client/workspace-servers.js).
    {
      version: 31,
      name: "framework-workspace-and-extensions-tables",
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS workspace_resources (
  id TEXT PRIMARY KEY,
  owner_email TEXT,
  org_id TEXT,
  kind TEXT,
  name TEXT,
  description TEXT,
  path TEXT,
  content TEXT,
  scope TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_resource_grants (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  app_id TEXT,
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  icon TEXT,
  created_at TEXT NOT NULL DEFAULT now(),
  updated_at TEXT NOT NULL DEFAULT now(),
  hidden_at TEXT,
  hidden_by TEXT,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tool_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now()
)`,
        sqlite: `CREATE TABLE IF NOT EXISTS workspace_resources (
  id TEXT PRIMARY KEY,
  owner_email TEXT,
  org_id TEXT,
  kind TEXT,
  name TEXT,
  description TEXT,
  path TEXT,
  content TEXT,
  scope TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_resource_grants (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  app_id TEXT,
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  icon TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  hidden_at TEXT,
  hidden_by TEXT,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tool_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
      },
    },
    // --- Projected income ledger (Recurly renewal imports + manual entries) --
    // external_key is NOT NULL (manual rows get a generated 'manual:<id>'
    // fallback) so the uniqueness index is a plain composite index — no
    // partial-index dialect divergence to worry about.
    {
      version: 32,
      name: "projected-entries-table",
      sql: `CREATE TABLE IF NOT EXISTS fp_projected_entries (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'personal',
        account_id TEXT,
        date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        external_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'projected',
        notes TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
CREATE UNIQUE INDEX IF NOT EXISTS fp_projected_entries_owner_key_idx ON fp_projected_entries (owner_email, external_key);
CREATE INDEX IF NOT EXISTS fp_projected_entries_owner_date_idx ON fp_projected_entries (owner_email, profile, date)`,
    },
    // --- Account nicknames (user-friendly display names) ------------------
    // App-side metadata: a friendly name the owner sets per account, kept
    // separate from the institution-provided `name` so a Plaid sync never
    // overwrites it. Nullable → falls back to `name` via COALESCE at display
    // sites. Works for both Plaid-linked and manual accounts.
    {
      version: 33,
      name: "accounts-add-display-name",
      sql: `ALTER TABLE fp_accounts ADD COLUMN IF NOT EXISTS display_name TEXT`,
    },
  ],
  { table: "fp_migrations" },
);
