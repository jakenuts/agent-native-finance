/**
 * Programmatic audit of profile-scoping compliance across the Finance
 * codebase. Two independent checks:
 *
 * 1. **Tables** — every `fp_`-prefixed table is introspected via the live DB
 *    catalog (information_schema.columns on Postgres, PRAGMA table_info on
 *    SQLite — same dialect switch `ensure-additive-columns.js` in
 *    @agent-native/core uses) to confirm it carries a `profile` column,
 *    unless it's a documented exception (see TABLE_EXCEPTIONS below).
 * 2. **Actions** — every `actions/*.ts` file is scanned for imports of a
 *    profile-scoped schema table (transactions, accounts, categories, rules,
 *    recurring, savedViews, budgetLines, paymentPlans). If it imports one of
 *    those AND never references `resolveEffectiveProfile` in its source AND
 *    isn't listed in ACTION_EXCEPTIONS, it's flagged as a violation.
 *
 * Read-only, self-hosted (fs access to actions/ is fine — this app has no
 * multi-tenant isolation boundary to cross).
 * Run:  pnpm action profile-audit
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDbExec, isPostgres } from "@agent-native/core/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIONS_DIR = path.resolve(__dirname);

/**
 * Tables that intentionally do NOT carry a `profile` column, with a truthful
 * one-line reason each. Anything else missing `profile` is a violation.
 */
const TABLE_EXCEPTIONS: Record<string, string> = {
  fp_institutions:
    "carries `default_profile` (applied to newly-discovered accounts) instead of `profile` — the institution itself isn't profile-scoped, its accounts are (profile lives on fp_accounts, the source of truth).",
  fp_settings: "generic per-owner key/value store (e.g. active_profile itself) — not a profile-scoped resource.",
  fp_migrations: "framework migration bookkeeping table, not an app data table.",
  fp_migrations_named: "framework migration bookkeeping table (name-keyed companion to fp_migrations), not an app data table.",
};

/**
 * Schema export names (from server/db/schema.ts) that are profile-scoped
 * list/analytics resources. An action importing one of these is expected to
 * route through `resolveEffectiveProfile` unless documented below.
 */
const SCOPED_TABLE_IMPORTS = [
  "transactions",
  "accounts",
  "categories",
  "rules",
  "recurring",
  "savedViews",
  "budgetLines",
  "paymentPlans",
  "projectedEntries",
];

/**
 * Actions that import a profile-scoped table but legitimately do not call
 * `resolveEffectiveProfile`, with a truthful one-line reason each. Populated
 * by manually reading every flagged action (see profile-audit task notes) —
 * do not add an entry here without verifying the action actually operates
 * safely without profile scoping.
 */
export const ACTION_EXCEPTIONS: Record<string, string> = {
  "get-transaction.ts": "operates on a single row by id, not a profile-scoped list.",
  "update-transaction.ts": "operates on a single transaction by id, not a profile-scoped list.",
  "set-transaction-category.ts": "operates on a single transaction by id, not a profile-scoped list.",
  "bulk-set-category.ts": "operates on an explicit, caller-supplied list of transaction ids, not a profile-scoped query.",
  "bulk-update-transactions.ts": "operates on an explicit, caller-supplied list of transaction ids, not a profile-scoped query.",
  "add-transaction-note.ts": "legacy alias that delegates to update-transaction's single-row-by-id code path.",
  "assign-transaction-recurring.ts": "links a single transaction (by id) to a single recurring (by id); both ids are already profile-scoped rows.",
  "delete-recurring.ts": "operates on a single recurring row by id; clears recurring_id on its own linked transactions only.",
  "update-recurring.ts": "operates on a single recurring row by id, not a profile-scoped list.",
  "update-rule.ts": "operates on a single rule row by id, not a profile-scoped list.",
  "delete-rule.ts": "operates on a single rule row by id, not a profile-scoped list.",
  "update-category.ts": "operates on a single category row by id, not a profile-scoped list.",
  "delete-category.ts": "operates on a single category row by id; reassigns/clears only the transactions and rules that reference that specific category id, not a profile-scoped query.",
  "update-saved-view.ts": "operates on a single saved view by id, not a profile-scoped list.",
  "delete-saved-view.ts": "operates on a single saved view by id, not a profile-scoped list.",
  "pin-saved-view.ts": "operates on a single saved view by id, not a profile-scoped list.",
  "set-account-profile.ts": "explicitly reassigns ONE account (by id) and cascades to only that account's own transactions/recurring rows — this action's entire purpose is to move a row between profiles, so it must write across the profile boundary by design.",
  "merge-accounts.ts": "operates on two explicit account ids (fromAccountId/intoAccountId); each account's own profile already scopes which rows move.",
  "dedupe-account-transactions.ts": "operates on a single explicit account id; the account's own profile already scopes its transactions.",
  "move-account-to-institution.ts": "operates on a single explicit account id; the account's own profile is unchanged by reparenting to a different institution.",
  "get-merge-suggestions.ts": "read-only duplicate-account scan; deliberately cross-profile because a mixed-login mis-tag (same physical account tagged personal on one row, business on another) is exactly the kind of duplicate this must catch to be useful.",
  "get-payment-plan.ts": "operates on a single payment plan by id, not a profile-scoped list.",
  "update-payment-plan.ts": "operates on a single payment plan by id, not a profile-scoped list.",
  "delete-payment-plan.ts": "operates on a single payment plan by id, not a profile-scoped list.",
  "match-plan-payments.ts": "operates on an explicit planId (or every active plan), matching transactions only against each plan's own payFromAccountId — the plan row's own profile already scopes which account (and therefore which profile's transactions) are searched.",
  "delete-transactions-by-ids.ts": "operates on an explicit, caller-supplied list of transaction ids (owner-checked), not a profile-scoped query.",
  "set-account-balance.ts": "updates the balance of a single manual account by id (owner-checked); the account's own profile is unaffected.",
  "update-manual-account.ts": "edits metadata of a single manual account by id (owner-checked), not a profile-scoped list.",
  "rename-account.ts": "sets the friendly nickname (display_name) of a single account by id (owner-checked); the account's own profile is unaffected.",
  "delete-manual-account.ts": "deletes a single manual account by id (owner-checked) and only its own transactions; not a profile-scoped query.",
  "update-projected-entry.ts": "operates on a single projected entry by id (owner-checked), not a profile-scoped list.",
  "delete-projected-entry.ts": "operates on a single projected entry by id (owner-checked), not a profile-scoped list.",
};

interface TableAuditEntry {
  name: string;
  hasProfileColumn: boolean;
  isException: boolean;
  exceptionReason?: string;
}

interface ActionAuditEntry {
  file: string;
  importsScopedTables: string[];
  callsResolveEffectiveProfile: boolean;
  isException: boolean;
  exceptionReason?: string;
  violation: boolean;
}

/** List every table name in the live DB catalog, filtered to `fp_` prefix. */
async function listFpTables(): Promise<string[]> {
  const exec = getDbExec();
  if (isPostgres()) {
    const { rows } = await exec.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'fp\\_%' ESCAPE '\\'`,
    );
    return rows.map((r) => String((r as Record<string, unknown>).table_name)).sort();
  }
  // SQLite: sqlite_master lists every table; PRAGMA table_info doesn't
  // support bound params, so filter the LIKE in-process instead.
  const { rows } = await exec.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fp\\_%' ESCAPE '\\'`,
  );
  return rows.map((r) => String((r as Record<string, unknown>).name)).sort();
}

/** Columns for one table via the same dialect-specific introspection as ensureAdditiveColumns. */
async function listColumns(tableName: string): Promise<Set<string>> {
  const exec = getDbExec();
  if (isPostgres()) {
    const { rows } = await exec.execute({
      sql: `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`,
      args: [tableName],
    });
    return new Set(rows.map((r) => String((r as Record<string, unknown>).column_name)));
  }
  // SQLite PRAGMA doesn't support bound parameters; tableName always comes
  // from sqlite_master (never user input), so it's safe to inline.
  const { rows } = await exec.execute(`PRAGMA table_info("${tableName}")`);
  return new Set(rows.map((r) => String((r as Record<string, unknown>).name)));
}

async function auditTables(): Promise<TableAuditEntry[]> {
  const tableNames = await listFpTables();
  const entries: TableAuditEntry[] = [];
  for (const name of tableNames) {
    const columns = await listColumns(name);
    const hasProfileColumn = columns.has("profile");
    const exceptionReason = TABLE_EXCEPTIONS[name];
    entries.push({
      name,
      hasProfileColumn,
      isException: exceptionReason != null,
      ...(exceptionReason != null ? { exceptionReason } : {}),
    });
  }
  return entries;
}

/** Match `import { a, b as c } from "../server/db/schema.js"` style named imports. */
function extractSchemaImports(source: string): string[] {
  const found = new Set<string>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["'][^"']*db\/schema(?:\.js)?["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source))) {
    const names = match[1]
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const n of names) found.add(n);
  }
  return [...found];
}

async function auditActions(): Promise<ActionAuditEntry[]> {
  const files = (await readdir(ACTIONS_DIR)).filter((f) => f.endsWith(".ts")).sort();
  const entries: ActionAuditEntry[] = [];
  for (const file of files) {
    const source = await readFile(path.join(ACTIONS_DIR, file), "utf8");
    const imports = extractSchemaImports(source);
    const importsScopedTables = SCOPED_TABLE_IMPORTS.filter((t) => imports.includes(t));
    const callsResolveEffectiveProfile = /resolveEffectiveProfile/.test(source);
    const exceptionReason = ACTION_EXCEPTIONS[file];
    const isException = exceptionReason != null;
    const violation = importsScopedTables.length > 0 && !callsResolveEffectiveProfile && !isException;
    entries.push({
      file,
      importsScopedTables,
      callsResolveEffectiveProfile,
      isException,
      ...(exceptionReason != null ? { exceptionReason } : {}),
      violation,
    });
  }
  return entries;
}

export default defineAction({
  description:
    "Programmatically audit profile-scoping compliance: (1) every fp_ table introspected via the live DB catalog for a `profile` column (flagging any without one, unless documented as an exception), and (2) every actions/*.ts file scanned for imports of a profile-scoped table without a resolveEffectiveProfile call (unless documented as an exception). Returns { tables, actions, violations }. Run this before considering any new profile-scoped feature done.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const [tables, actions] = await Promise.all([auditTables(), auditActions()]);

    const violations: string[] = [
      ...tables.filter((t) => !t.hasProfileColumn && !t.isException).map((t) => t.name),
      ...actions.filter((a) => a.violation).map((a) => a.file),
    ];

    return { tables, actions, violations };
  },
});
