/**
 * Rocket Money CSV import: parse RM's export format, map rows onto Finance's
 * schema, find-or-create manual accounts/categories, dedupe against existing
 * (especially Plaid-linked) data, and batch-insert. Framework-light (takes a
 * db instance) so it's usable from the import-rm-csv action and dry-run mode
 * alike.
 *
 * RM CSV header (verified against real exports):
 *   Date,Original Date,Account Type,Account Name,Account Number,
 *   Institution Name,Name,Custom Name,Amount,Description,Category,Note,
 *   Ignored From,Tax Deductible,Transaction Tags
 *
 * Sign convention (VERIFIED against real Personal/Business exports, see
 * AGENTS.md): RM's Amount already matches Finance's convention —
 * positive = money OUT (expense), negative = money IN (income/refund). Rows
 * categorized "Income"-like are overwhelmingly negative; everything else is
 * overwhelmingly positive. NO sign flip is applied.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, categories, institutions, transactions } from "../db/schema.js";
import type { Profile } from "./profile.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

export const RM_CSV_HEADER = [
  "Date",
  "Original Date",
  "Account Type",
  "Account Name",
  "Account Number",
  "Institution Name",
  "Name",
  "Custom Name",
  "Amount",
  "Description",
  "Category",
  "Note",
  "Ignored From",
  "Tax Deductible",
  "Transaction Tags",
] as const;

// --- Minimal robust CSV parser (handles quoted fields with embedded commas,
// escaped quotes `""`, and CRLF/LF line endings) --------------------------

/** Parse a full CSV string into rows of string cells. No external dep. */
export function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  const n = raw.length;

  function endField() {
    row.push(cur);
    cur = "";
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue; // normalize CRLF -> LF handling below
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  // Trailing row (file may or may not end with a newline).
  if (cur.length > 0 || row.length > 0) endRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface RmCsvRow {
  date: string;
  originalDate: string;
  accountType: string;
  accountName: string;
  accountNumber: string;
  institutionName: string;
  name: string;
  customName: string;
  amount: string;
  description: string;
  category: string;
  note: string;
  ignoredFrom: string;
  taxDeductible: string;
  transactionTags: string;
}

/** Parse raw CSV text into typed RM rows, validating the header shape. */
export function parseRmCsv(raw: string): RmCsvRow[] {
  const table = parseCsv(raw);
  if (table.length === 0) return [];
  const header = table[0].map((h) => h.trim());
  const missing = RM_CSV_HEADER.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    throw new Error(`Unrecognized Rocket Money CSV — missing column(s): ${missing.join(", ")}`);
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const rows: RmCsvRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    if (cells.length === 1 && cells[0].trim() === "") continue;
    rows.push({
      date: (cells[idx["Date"]] ?? "").trim(),
      originalDate: (cells[idx["Original Date"]] ?? "").trim(),
      accountType: (cells[idx["Account Type"]] ?? "").trim(),
      accountName: (cells[idx["Account Name"]] ?? "").trim(),
      accountNumber: (cells[idx["Account Number"]] ?? "").trim(),
      institutionName: (cells[idx["Institution Name"]] ?? "").trim(),
      name: (cells[idx["Name"]] ?? "").trim(),
      customName: (cells[idx["Custom Name"]] ?? "").trim(),
      amount: (cells[idx["Amount"]] ?? "").trim(),
      description: (cells[idx["Description"]] ?? "").trim(),
      category: (cells[idx["Category"]] ?? "").trim(),
      note: (cells[idx["Note"]] ?? "").trim(),
      ignoredFrom: (cells[idx["Ignored From"]] ?? "").trim(),
      taxDeductible: (cells[idx["Tax Deductible"]] ?? "").trim(),
      transactionTags: (cells[idx["Transaction Tags"]] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * Normalize a date cell to YYYY-MM-DD. RM's own exports are already ISO
 * (passed through), but hand-made/non-ISO CSVs commonly use US M/D/YYYY —
 * previously those rows were silently DROPPED as "invalid date". Accept
 * US-style M/D/YYYY, MM/DD/YYYY, and 2-digit-year M/D/YY (→ 20YY), converting
 * to ISO. Anything else returns null (still dropped).
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
export function normalizeRmDate(value: string): string | null {
  const trimmed = value.trim();
  if (ISO_DATE_RE.test(trimmed)) return trimmed;

  const us = US_DATE_RE.exec(trimmed);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    let year = Number(us[3]);
    if (us[3].length === 2) year += 2000; // M/D/YY → 20YY
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  return null;
}

/** Parse RM's Amount field ("1234.56", "-12.3") to signed integer cents. No sign flip — see module doc. */
export function amountToCents(amount: string): number | null {
  const n = Number(amount.replace(/[,$]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Map RM's free-text Account Type to our fp_accounts.type/subtype convention. */
export function mapAccountType(rmType: string): { type: string; subtype: string | null } {
  const t = rmType.trim().toLowerCase();
  if (t === "credit card") return { type: "credit", subtype: "credit card" };
  if (t === "cash") return { type: "depository", subtype: "checking" };
  return { type: "depository", subtype: null };
}

/** Last 4 chars of an account number string (RM masks vary in length). */
export function last4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : digits;
}

/** Deterministic key for grouping CSV rows into one manual account. */
export function accountGroupKey(row: RmCsvRow): string {
  return `${row.institutionName}::${row.accountName}::${last4(row.accountNumber)}`;
}

/** Deterministic imported-transaction id: 'rm_' + sha1(...) — dedupes re-imports via the existing unique index on plaid_transaction_id. */
export function rmTransactionId(opts: {
  owner: string;
  institutionKey: string;
  accountNumber: string;
  date: string;
  amountCents: number;
  name: string;
  dupeIndex: number;
}): string {
  const basis = [
    opts.owner,
    opts.institutionKey,
    opts.accountNumber,
    opts.date,
    String(opts.amountCents),
    opts.name,
    String(opts.dupeIndex),
  ].join("|");
  const hash = createHash("sha1").update(basis).digest("hex");
  return `rm_${hash}`;
}

/** Bucket a RM category name into a fp_categories.category_group. */
export function categoryGroupForName(name: string): "expenses" | "earnings" | "ignored" {
  const n = name.trim().toLowerCase();
  if (!n) return "expenses";
  if (n.includes("income") || n.includes("paycheck") || n.includes("deposit") || n.includes("salary")) {
    return "earnings";
  }
  if (n.includes("transfer") || n.includes("credit card payment") || n === "owner draw" || n.includes("owner draw")) {
    return "ignored";
  }
  return "expenses";
}

export interface ImportSummaryRow {
  accountKey: string;
  institutionName: string;
  accountName: string;
  last4: string;
  profile: Profile;
}

export interface RmImportPlan {
  totalRows: number;
  parsedRows: number;
  skippedInvalidRows: number;
  accountsToCreate: ImportSummaryRow[];
  existingManualAccountMatches: number;
  categoriesToCreate: string[];
  duplicates: number;
  importable: number;
}

interface ResolvedRow {
  row: RmCsvRow;
  date: string;
  amountCents: number;
  merchantName: string;
  accountKey: string;
}

/** Parse + validate rows, splitting out unusable ones (bad date/amount). */
function resolveRows(rows: RmCsvRow[]): {
  resolved: ResolvedRow[];
  skippedInvalidRows: number;
} {
  const resolved: ResolvedRow[] = [];
  let skippedInvalidRows = 0;
  for (const row of rows) {
    const date = normalizeRmDate(row.date);
    const amountCents = amountToCents(row.amount);
    if (!date || amountCents == null) {
      skippedInvalidRows++;
      continue;
    }
    const merchantName = row.customName || row.name || "Unknown";
    resolved.push({ row, date, amountCents, merchantName, accountKey: accountGroupKey(row) });
  }
  return { resolved, skippedInvalidRows };
}

/**
 * Build an import plan (dry-run summary) without writing anything. Also used
 * as the first phase of a real import so both paths share exactly one
 * dedupe/account-matching implementation.
 */
export async function planRmImport(
  db: Db,
  owner: string,
  profile: Profile,
  csvRows: RmCsvRow[],
): Promise<
  RmImportPlan & {
    resolved: ResolvedRow[];
    accountKeyToExistingId: Map<string, string>;
    accountKeyToPlaidMatch: Map<string, string>;
    dupeTransactionIds: Set<string>;
    existingCategoryKey: Set<string>;
  }
> {
  const { resolved, skippedInvalidRows } = resolveRows(csvRows);

  // --- Account matching -------------------------------------------------
  // 1. Exact match against an existing MANUAL account created by a prior
  //    import (same owner/institution/account-name/last4).
  // 2. Fuzzy match against an existing PLAID-LINKED account by
  //    institution-name substring + mask match — this is how we catch
  //    "Example Bank ...7637" overlap for dedup purposes (not reassignment).
  const existingAccounts = await db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      name: accounts.name,
      mask: accounts.mask,
      isManual: accounts.isManual,
    })
    .from(accounts)
    .where(eq(accounts.ownerEmail, owner));
  const instRows = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutions)
    .where(eq(institutions.ownerEmail, owner));
  const instNameById = new Map(instRows.map((i) => [i.id, i.name]));

  // Manual accounts created by earlier RM imports, keyed the same way we key CSV rows.
  const manualAccountKey = new Map<string, string>(); // accountKey -> account id
  for (const a of existingAccounts) {
    if (!a.isManual) continue;
    const instName = instNameById.get(a.institutionId) ?? "";
    const key = `${instName}::${a.name ?? ""}::${a.mask ?? ""}`;
    manualAccountKey.set(key, a.id);
  }

  // Plaid-linked accounts, for dedupe-only fuzzy matching by institution + mask.
  const plaidLinked = existingAccounts.filter((a) => !a.isManual);

  const accountKeys = new Set(resolved.map((r) => r.accountKey));
  const accountKeyToExistingId = new Map<string, string>();
  const accountKeyToPlaidMatch = new Map<string, string>();
  const accountsToCreate: ImportSummaryRow[] = [];

  for (const key of accountKeys) {
    const sample = resolved.find((r) => r.accountKey === key)!.row;
    const mask = last4(sample.accountNumber);

    const existingManual = manualAccountKey.get(key);
    if (existingManual) {
      accountKeyToExistingId.set(key, existingManual);
      continue;
    }

    const plaidMatch = plaidLinked.find((a) => {
      const instName = (instNameById.get(a.institutionId) ?? "").toLowerCase();
      const rmInst = sample.institutionName.toLowerCase();
      const institutionOverlap =
        instName.includes(rmInst) || rmInst.includes(instName);
      return institutionOverlap && mask && a.mask === mask;
    });
    if (plaidMatch) {
      accountKeyToPlaidMatch.set(key, plaidMatch.id);
      // Still no manual account needed — transactions dedupe against the
      // Plaid account's existing rows, but any NON-duplicate rows for this
      // account key have nowhere to land without a manual account, so we
      // still plan to create one lazily only if needed at write time. For
      // planning purposes we surface it as a create candidate with a note.
    }

    accountsToCreate.push({
      accountKey: key,
      institutionName: sample.institutionName,
      accountName: sample.accountName,
      last4: mask,
      profile,
    });
  }

  // --- Category matching --------------------------------------------------
  const existingCategories = await db
    .select({ id: categories.id, name: categories.name, profile: categories.profile })
    .from(categories)
    .where(eq(categories.ownerEmail, owner));
  const existingCategoryKey = new Set(
    existingCategories
      .filter((c) => c.profile === profile)
      .map((c) => c.name.trim().toLowerCase()),
  );
  const csvCategoryNames = new Set(
    resolved.map((r) => r.row.category.trim()).filter((c) => c.length > 0),
  );
  const categoriesToCreate = [...csvCategoryNames].filter(
    (name) => !existingCategoryKey.has(name.toLowerCase()),
  );

  // --- Dedupe against existing fp_transactions ----------------------------
  // A row is a duplicate iff its resolved account maps to an EXISTING
  // Plaid-linked account (by institution+mask) AND a transaction already
  // exists on that account with the same date + amountCents.
  const dupeTransactionIds = new Set<string>();
  let duplicates = 0;
  const plaidMatchAccountIds = new Set([...accountKeyToPlaidMatch.values()]);
  if (plaidMatchAccountIds.size > 0) {
    const existingTx = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        date: transactions.date,
        amountCents: transactions.amountCents,
      })
      .from(transactions)
      .where(eq(transactions.ownerEmail, owner));
    const existingKey = new Set(
      existingTx
        .filter((t) => plaidMatchAccountIds.has(t.accountId))
        .map((t) => `${t.accountId}|${t.date}|${t.amountCents}`),
    );
    for (const r of resolved) {
      const plaidAccountId = accountKeyToPlaidMatch.get(r.accountKey);
      if (!plaidAccountId) continue;
      const key = `${plaidAccountId}|${r.date}|${r.amountCents}`;
      if (existingKey.has(key)) {
        duplicates++;
        dupeTransactionIds.add(`${r.accountKey}|${r.date}|${r.amountCents}|${r.merchantName}`);
      }
    }
  }

  return {
    totalRows: csvRows.length,
    parsedRows: resolved.length,
    skippedInvalidRows,
    accountsToCreate,
    existingManualAccountMatches: accountKeyToExistingId.size,
    categoriesToCreate,
    duplicates,
    importable: resolved.length - duplicates,
    resolved,
    accountKeyToExistingId,
    accountKeyToPlaidMatch,
    dupeTransactionIds,
    existingCategoryKey,
  };
}

export interface RmImportResult {
  ok: true;
  dryRun: boolean;
  rowsParsed: number;
  skippedInvalidRows: number;
  accountsCreated: string[];
  categoriesCreated: string[];
  imported: number;
  duplicatesSkipped: number;
  elapsedMs: number;
  /**
   * When nothing usable was found, a human-readable reason the UI/agent can
   * surface instead of a silent "0 imported" success. null when rows parsed
   * fine.
   */
  reason: string | null;
}

/** Explain why an import yielded no importable rows (0 parsed, or all skipped/duplicate). */
function explainEmpty(plan: {
  totalRows: number;
  parsedRows: number;
  skippedInvalidRows: number;
  duplicates: number;
}): string | null {
  if (plan.totalRows === 0) {
    return "No data rows found in the file. Expected a Rocket Money CSV with a header row followed by transaction rows.";
  }
  if (plan.parsedRows === 0) {
    return `All ${plan.totalRows} row(s) were skipped because their Date or Amount couldn't be read. Rocket Money exports use ISO dates (YYYY-MM-DD) or US M/D/YYYY, and a numeric Amount column — check that the Date and Amount columns are populated.`;
  }
  const importable = plan.parsedRows - plan.duplicates;
  if (importable <= 0) {
    return `All ${plan.parsedRows} parsed row(s) already exist (duplicates of already-synced/imported transactions) — nothing new to import.`;
  }
  return null;
}

const INSERT_BATCH_SIZE = 500;

/**
 * Execute a real import (or, if dryRun, just return the plan reshaped as a
 * result summary without writing). Batches transaction inserts in chunks of
 * ~500 for throughput on large files (Personal export is ~27K rows).
 */
export async function runRmImport(
  db: Db,
  owner: string,
  profile: Profile,
  csvRows: RmCsvRow[],
  dryRun: boolean,
): Promise<RmImportResult> {
  const start = Date.now();
  const plan = await planRmImport(db, owner, profile, csvRows);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      rowsParsed: plan.parsedRows,
      skippedInvalidRows: plan.skippedInvalidRows,
      accountsCreated: plan.accountsToCreate.map(
        (a) => `${a.accountName} ••${a.last4} (${a.institutionName})`,
      ),
      categoriesCreated: plan.categoriesToCreate,
      imported: 0,
      duplicatesSkipped: plan.duplicates,
      elapsedMs: Date.now() - start,
      reason: explainEmpty(plan),
    };
  }

  const nowIso = new Date().toISOString();

  // 1. Create any missing manual accounts (one per distinct accountKey not
  //    already matched to an existing manual account). If a plaid match
  //    exists for a key, non-duplicate rows for that key still need SOME
  //    account to live on — we create a manual account for them too, since
  //    the point of dedup is skipping exact-match rows, not merging history
  //    into the Plaid-synced account (which sync would then contest).
  const accountKeyToAccountId = new Map<string, string>(plan.accountKeyToExistingId);
  const createdAccountNames: string[] = [];

  for (const candidate of plan.accountsToCreate) {
    if (accountKeyToAccountId.has(candidate.accountKey)) continue;
    const sampleResolved = plan.resolved.find((r) => r.accountKey === candidate.accountKey)!;
    const { type, subtype } = mapAccountType(sampleResolved.row.accountType);

    const id = crypto.randomUUID();
    await db.insert(accounts).values({
      id,
      ownerEmail: owner,
      institutionId: await findOrCreateManualInstitution(db, owner, candidate.institutionName, profile),
      plaidAccountId: `manual_${id}`,
      name: candidate.accountName,
      officialName: null,
      mask: candidate.last4 || null,
      type,
      subtype,
      currentBalanceCents: null,
      availableBalanceCents: null,
      isoCurrency: "USD",
      isActive: true,
      profile,
      isManual: true,
      createdAt: nowIso,
    });
    accountKeyToAccountId.set(candidate.accountKey, id);
    createdAccountNames.push(`${candidate.accountName} ••${candidate.last4} (${candidate.institutionName})`);
  }

  // Precompute accountId -> institutionId for every account referenced by
  // this import (existing manual matches + Plaid matches + newly created),
  // so the transaction-insert loop below never issues a per-row query.
  const allReferencedAccountIds = new Set<string>([
    ...accountKeyToAccountId.values(),
    ...plan.accountKeyToPlaidMatch.values(),
  ]);
  const institutionIdByAccountId = new Map<string, string>();
  if (allReferencedAccountIds.size > 0) {
    const rows = await db
      .select({ id: accounts.id, institutionId: accounts.institutionId })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    for (const r of rows) {
      if (allReferencedAccountIds.has(r.id)) institutionIdByAccountId.set(r.id, r.institutionId);
    }
  }

  // 2. Create any missing custom categories for this profile.
  const categoryIdByName = new Map<string, string>();
  const existingCats = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.ownerEmail, owner), eq(categories.profile, profile)));
  for (const c of existingCats) categoryIdByName.set(c.name.trim().toLowerCase(), c.id);

  const createdCategoryNames: string[] = [];
  for (const name of plan.categoriesToCreate) {
    const key = name.trim().toLowerCase();
    if (categoryIdByName.has(key)) continue;
    const id = `cat_rm_${crypto.randomUUID().slice(0, 8)}`;
    const group = categoryGroupForName(name);
    await db.insert(categories).values({
      id,
      ownerEmail: owner,
      name,
      categoryGroup: group,
      icon: null,
      color: null,
      isSystem: false,
      profile,
      createdAt: nowIso,
    });
    categoryIdByName.set(key, id);
    createdCategoryNames.push(name);
  }

  // 3. Build transaction insert values, skipping duplicates, batched.
  type TxInsert = typeof transactions.$inferInsert;
  const toInsert: TxInsert[] = [];
  let duplicatesSkipped = 0;
  let sequenceIndex = 0;

  for (const r of plan.resolved) {
    const plaidAccountId = plan.accountKeyToPlaidMatch.get(r.accountKey);
    if (plaidAccountId) {
      // Re-check duplicate at write time using the same key shape as planRmImport.
      const dupeKey = `${r.accountKey}|${r.date}|${r.amountCents}|${r.merchantName}`;
      if (plan.dupeTransactionIds.has(dupeKey)) {
        duplicatesSkipped++;
        continue;
      }
    }

    const accountId = accountKeyToAccountId.get(r.accountKey);
    if (!accountId) continue; // should not happen — every key has an account by now

    const categoryName = r.row.category.trim();
    const categoryId = categoryName ? (categoryIdByName.get(categoryName.toLowerCase()) ?? null) : null;

    const isIgnored = r.row.ignoredFrom.trim().length > 0;
    const isTaxDeductible = r.row.taxDeductible.trim().toLowerCase() === "yes";
    let note = r.row.note || null;
    if (r.row.transactionTags.trim()) {
      note = note ? `${note} [tags: ${r.row.transactionTags.trim()}]` : `[tags: ${r.row.transactionTags.trim()}]`;
    }

    // Deterministic id: a monotonic index over resolved rows (stable file
    // order) makes the hash unique per row AND identical across re-imports
    // of the same file, so re-running the same CSV naturally dedupes via
    // the existing unique index on plaid_transaction_id without writing
    // duplicate transactions for genuinely repeated same-day/same-amount
    // charges (e.g. two identical $12 coffee purchases in one day).
    sequenceIndex++;
    const plaidTransactionId = rmTransactionId({
      owner,
      institutionKey: r.row.institutionName,
      accountNumber: r.row.accountNumber,
      date: r.date,
      amountCents: r.amountCents,
      name: r.merchantName,
      dupeIndex: sequenceIndex,
    });

    toInsert.push({
      id: crypto.randomUUID(),
      ownerEmail: owner,
      accountId,
      institutionId: institutionIdByAccountId.get(accountId) ?? "",
      plaidTransactionId,
      date: r.date,
      authorizedDate: normalizeRmDate(r.row.originalDate) ?? r.date,
      name: r.row.name || r.merchantName,
      merchantName: r.merchantName,
      amountCents: r.amountCents,
      isoCurrency: "USD",
      pending: false,
      pfcPrimary: null,
      pfcDetailed: null,
      categoryId,
      categoryLocked: Boolean(categoryId),
      note,
      rawPlaid: null,
      recurringId: null,
      isIgnored,
      isTaxDeductible,
      profile,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  let imported = 0;
  let reimportSkipped = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
    const batch = toInsert.slice(i, i + INSERT_BATCH_SIZE);
    if (batch.length === 0) continue;
    const insertedRows = await db
      .insert(transactions)
      .values(batch)
      .onConflictDoNothing({ target: transactions.plaidTransactionId })
      .returning({ id: transactions.id });
    imported += insertedRows.length;
    reimportSkipped += batch.length - insertedRows.length;
  }

  return {
    ok: true,
    dryRun: false,
    rowsParsed: plan.parsedRows,
    skippedInvalidRows: plan.skippedInvalidRows,
    accountsCreated: createdAccountNames,
    categoriesCreated: createdCategoryNames,
    imported,
    // duplicatesSkipped (Plaid-overlap rows filtered before insert) +
    // reimportSkipped (rows that hit the unique index — a repeat run of the
    // same file). These are disjoint sets, unlike plan.duplicates which
    // duplicatesSkipped already equals for this run.
    duplicatesSkipped: duplicatesSkipped + reimportSkipped,
    elapsedMs: Date.now() - start,
    reason: imported === 0 ? explainEmpty(plan) : null,
  };
}

/** Find-or-create a manual (non-Plaid) institution row for RM-imported accounts. */
async function findOrCreateManualInstitution(
  db: Db,
  owner: string,
  institutionName: string,
  profile: Profile,
): Promise<string> {
  const key = `manual:${institutionName.trim().toLowerCase()}`;
  const found = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(and(eq(institutions.ownerEmail, owner), eq(institutions.plaidItemId, key)));
  if (found.length > 0) return found[0].id;

  const id = crypto.randomUUID();
  await db.insert(institutions).values({
    id,
    ownerEmail: owner,
    plaidItemId: key,
    plaidInstitutionId: null,
    name: institutionName,
    accessToken: "manual_import",
    status: "manual",
    defaultProfile: profile,
    createdAt: new Date().toISOString(),
  });
  return id;
}
