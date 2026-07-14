/**
 * Account merge/dedupe engine. Solves the "same real-world account shows up
 * more than once" problem created by (a) re-linking a bank login without
 * Plaid Link's update mode (creates a second Plaid Item that duplicates
 * accounts already known from an earlier Item) and (b) importing a Rocket
 * Money CSV that creates manual accounts/institutions overlapping accounts
 * already linked live via Plaid.
 *
 * Three operations, framework-light (take a db instance) so they're usable
 * from actions and tests alike:
 *   - mergeAccounts: move one account's history into another, then dedupe
 *     overlapping (imported vs Plaid-real) transaction rows, then delete the
 *     emptied source account.
 *   - mergeSuggestions: read-only scan for likely-duplicate account pairs
 *     (and whole-institution duplicates) to present to the user before
 *     merging anything.
 *   - moveAccountToInstitution: reparent a manual account under a different
 *     institution card (e.g. attach a CSV-only "Regular Savings" history
 *     account under the surviving Example Bank institution) without a
 *     full account merge.
 */
import { eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  institutions,
  paymentPlans,
  recurring,
  transactions,
} from "../db/schema.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

function nowIso(): string {
  return new Date().toISOString();
}

/** Imported (Rocket Money CSV) transaction ids are always 'rm_<sha1>'. */
export function isImportedTransactionId(plaidTransactionId: string | null | undefined): boolean {
  return Boolean(plaidTransactionId && plaidTransactionId.startsWith("rm_"));
}

// --------------------------------------------------------------------------
// mergeAccounts
// --------------------------------------------------------------------------

export interface MergeAccountsResult {
  ok: true;
  fromAccountId: string;
  intoAccountId: string;
  fromAccountName: string | null;
  intoAccountName: string | null;
  transactionsMoved: number;
  recurringMoved: number;
  paymentPlansMoved: number;
  duplicatesRemoved: number;
  fromAccountDeleted: boolean;
}

/**
 * Move everything referencing `fromAccountId` onto `intoAccountId`, dedupe
 * same-money rows that now collide (one imported via CSV, the other real via
 * Plaid), then delete the emptied source account.
 */
export async function mergeAccounts(
  db: Db,
  owner: string,
  fromAccountId: string,
  intoAccountId: string,
): Promise<MergeAccountsResult> {
  if (fromAccountId === intoAccountId) {
    throw new Error("Cannot merge an account into itself.");
  }

  const [fromRows, intoRows] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.id, fromAccountId)),
    db.select().from(accounts).where(eq(accounts.id, intoAccountId)),
  ]);
  const fromAccount = fromRows[0];
  const intoAccount = intoRows[0];
  if (!fromAccount) throw new Error(`Account ${fromAccountId} not found.`);
  if (!intoAccount) throw new Error(`Account ${intoAccountId} not found.`);
  if (fromAccount.ownerEmail !== owner || intoAccount.ownerEmail !== owner) {
    throw new Error("Account does not belong to the current owner.");
  }

  // 1. Move fp_transactions: account_id + institution_id + profile denorm to target.
  const [{ n: txCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.accountId, fromAccountId));
  await db
    .update(transactions)
    .set({
      accountId: intoAccountId,
      institutionId: intoAccount.institutionId,
      profile: intoAccount.profile,
      updatedAt: nowIso(),
    })
    .where(eq(transactions.accountId, fromAccountId));

  // 2. Move fp_recurring.account_id refs.
  const [{ n: recurringCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(recurring)
    .where(eq(recurring.accountId, fromAccountId));
  await db
    .update(recurring)
    .set({ accountId: intoAccountId, updatedAt: nowIso() })
    .where(eq(recurring.accountId, fromAccountId));

  // 3. Move fp_payment_plans card/pay-from refs.
  const [{ n: planCardCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(paymentPlans)
    .where(eq(paymentPlans.cardAccountId, fromAccountId));
  await db
    .update(paymentPlans)
    .set({ cardAccountId: intoAccountId, updatedAt: nowIso() })
    .where(eq(paymentPlans.cardAccountId, fromAccountId));
  const [{ n: planPayFromCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(paymentPlans)
    .where(eq(paymentPlans.payFromAccountId, fromAccountId));
  await db
    .update(paymentPlans)
    .set({ payFromAccountId: intoAccountId, updatedAt: nowIso() })
    .where(eq(paymentPlans.payFromAccountId, fromAccountId));

  // 4. Dedupe within the target account: identical (date, amount_cents) pairs
  // where one row is imported (rm_ prefix) and the other is Plaid-real. Keep
  // the survivor (prefer the Plaid-real row so future syncs still match it by
  // plaid_transaction_id), carrying over note/category from the loser if the
  // survivor lacks them.
  const targetTx = await db
    .select({
      id: transactions.id,
      plaidTransactionId: transactions.plaidTransactionId,
      date: transactions.date,
      amountCents: transactions.amountCents,
      note: transactions.note,
      categoryId: transactions.categoryId,
      categoryLocked: transactions.categoryLocked,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(eq(transactions.accountId, intoAccountId));

  const byKey = new Map<string, typeof targetTx>();
  for (const t of targetTx) {
    const key = `${t.date ?? ""}|${t.amountCents}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }

  let duplicatesRemoved = 0;
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const imported = group.filter((t) => isImportedTransactionId(t.plaidTransactionId));
    const real = group.filter((t) => !isImportedTransactionId(t.plaidTransactionId));
    if (imported.length === 0 || real.length === 0) continue; // not an import/real collision

    // Keep exactly one real survivor per group (first one); every imported
    // row in the group is redundant with it, and any EXTRA real rows are
    // left alone (genuine same-day/same-amount repeats, not our concern here).
    const survivor = real[0];
    for (const dupe of imported) {
      const needsNote = !survivor.note && dupe.note;
      const needsCategory = !survivor.categoryId && dupe.categoryId;
      if (needsNote || needsCategory) {
        await db
          .update(transactions)
          .set({
            ...(needsNote ? { note: dupe.note } : {}),
            ...(needsCategory
              ? { categoryId: dupe.categoryId, categoryLocked: dupe.categoryLocked }
              : {}),
            updatedAt: nowIso(),
          })
          .where(eq(transactions.id, survivor.id));
      }
      await db.delete(transactions).where(eq(transactions.id, dupe.id));
      duplicatesRemoved++;
    }
  }

  // 5. Delete the emptied source account.
  await db.delete(accounts).where(eq(accounts.id, fromAccountId));

  return {
    ok: true,
    fromAccountId,
    intoAccountId,
    fromAccountName: fromAccount.name,
    intoAccountName: intoAccount.name,
    transactionsMoved: Number(txCount ?? 0),
    recurringMoved: Number(recurringCount ?? 0),
    paymentPlansMoved: Number(planCardCount ?? 0) + Number(planPayFromCount ?? 0),
    duplicatesRemoved,
    fromAccountDeleted: true,
  };
}

// --------------------------------------------------------------------------
// dedupeAccountTransactions (same dedupe pass, without a merge — for
// post-backfill cleanup when Plaid's HISTORICAL_UPDATE fills in history that
// overlaps CSV-imported rows already sitting on the SAME account)
// --------------------------------------------------------------------------

export interface DedupeResult {
  ok: true;
  accountId: string;
  duplicatesRemoved: number;
}

export async function dedupeAccountTransactions(db: Db, accountId: string): Promise<DedupeResult> {
  const rows = await db
    .select({
      id: transactions.id,
      plaidTransactionId: transactions.plaidTransactionId,
      date: transactions.date,
      amountCents: transactions.amountCents,
      note: transactions.note,
      categoryId: transactions.categoryId,
      categoryLocked: transactions.categoryLocked,
    })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));

  const byKey = new Map<string, typeof rows>();
  for (const t of rows) {
    const key = `${t.date ?? ""}|${t.amountCents}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }

  let duplicatesRemoved = 0;
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const imported = group.filter((t) => isImportedTransactionId(t.plaidTransactionId));
    const real = group.filter((t) => !isImportedTransactionId(t.plaidTransactionId));
    if (imported.length === 0 || real.length === 0) continue;

    const survivor = real[0];
    for (const dupe of imported) {
      const needsNote = !survivor.note && dupe.note;
      const needsCategory = !survivor.categoryId && dupe.categoryId;
      if (needsNote || needsCategory) {
        await db
          .update(transactions)
          .set({
            ...(needsNote ? { note: dupe.note } : {}),
            ...(needsCategory
              ? { categoryId: dupe.categoryId, categoryLocked: dupe.categoryLocked }
              : {}),
            updatedAt: nowIso(),
          })
          .where(eq(transactions.id, survivor.id));
      }
      await db.delete(transactions).where(eq(transactions.id, dupe.id));
      duplicatesRemoved++;
    }
  }

  return { ok: true, accountId, duplicatesRemoved };
}

// --------------------------------------------------------------------------
// mergeSuggestions
// --------------------------------------------------------------------------

export interface MergeSuggestion {
  /** Stable key so the UI can dedupe repeated suggestions across renders. */
  key: string;
  reason: "same-mask" | "institution-all-duplicates";
  accountMask: string | null;
  accountType: string | null;
  candidates: Array<{
    accountId: string;
    accountName: string | null;
    institutionId: string;
    institutionName: string;
    isManual: boolean;
    isPlaidLinked: boolean;
    lastSyncedAt: string | null;
    currentBalanceCents: number | null;
  }>;
  /** Suggested merge target (plaid-linked + most recently synced wins). */
  targetAccountId: string;
  targetAccountName: string | null;
  /** Suggested merge sources (everything else in the group). */
  sourceAccountIds: string[];
  /** True when EVERY account at a given institution is a suggested source
   * (i.e. merging would leave that institution empty) — surfaced so the UI
   * can also offer "remove this institution" alongside the per-account merges. */
  institutionFullyDuplicate?: { institutionId: string; institutionName: string };
}

function compatibleTypes(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  // "checking" vs "depository" naming drift across sources — treat depository
  // subtypes as compatible with each other, but never cross credit/depository.
  return false;
}

/**
 * Scan for likely-duplicate account pairs: same non-null mask + compatible
 * type, across DIFFERENT institutions (same-institution same-mask accounts
 * are unusual and not auto-suggested to avoid false positives). Prefers a
 * Plaid-linked, most-recently-synced account as the merge target.
 */
export async function mergeSuggestions(db: Db, owner: string): Promise<MergeSuggestion[]> {
  const acctRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      mask: accounts.mask,
      type: accounts.type,
      subtype: accounts.subtype,
      isManual: accounts.isManual,
      institutionId: accounts.institutionId,
      currentBalanceCents: accounts.currentBalanceCents,
    })
    .from(accounts)
    .where(eq(accounts.ownerEmail, owner));

  const instRows = await db
    .select({
      id: institutions.id,
      name: institutions.name,
      status: institutions.status,
      accessToken: institutions.accessToken,
      lastSyncedAt: institutions.lastSyncedAt,
    })
    .from(institutions)
    .where(eq(institutions.ownerEmail, owner));
  const instById = new Map(instRows.map((i) => [i.id, i]));

  function isPlaidLinked(institutionId: string): boolean {
    const inst = instById.get(institutionId);
    if (!inst) return false;
    return inst.status !== "manual" && inst.accessToken !== "manual_import";
  }

  // Group by (mask, compatible-type-bucket), across institutions.
  const groups = new Map<string, typeof acctRows>();
  for (const a of acctRows) {
    if (!a.mask) continue; // mask-less accounts (e.g. some PayPal/Venmo rows) aren't groupable this way
    const typeBucket = a.type ?? "unknown";
    const key = `${a.mask}::${typeBucket}`;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }

  const suggestions: MergeSuggestion[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // Only suggest across >=2 distinct institutions (same-institution
    // same-mask duplicates are rare/ambiguous; skip to avoid false merges).
    const distinctInstitutions = new Set(group.map((a) => a.institutionId));
    if (distinctInstitutions.size < 2) continue;
    // All pairs in the group must have compatible types (grouping key already
    // encodes type, so this is always true, but keep the guard for subtype-aware
    // future tightening).
    if (!group.every((a) => compatibleTypes(a.type, group[0].type))) continue;

    const candidates = group.map((a) => {
      const inst = instById.get(a.institutionId);
      return {
        accountId: a.id,
        accountName: a.name,
        institutionId: a.institutionId,
        institutionName: inst?.name ?? "Unknown institution",
        isManual: Boolean(a.isManual),
        isPlaidLinked: isPlaidLinked(a.institutionId),
        lastSyncedAt: inst?.lastSyncedAt ?? null,
        currentBalanceCents: a.currentBalanceCents,
      };
    });

    // Target: prefer Plaid-linked, then most recently synced, then non-manual.
    const sorted = [...candidates].sort((a, b) => {
      if (a.isPlaidLinked !== b.isPlaidLinked) return a.isPlaidLinked ? -1 : 1;
      const aSync = a.lastSyncedAt ?? "";
      const bSync = b.lastSyncedAt ?? "";
      if (aSync !== bSync) return aSync > bSync ? -1 : 1;
      if (a.isManual !== b.isManual) return a.isManual ? 1 : -1;
      return 0;
    });
    const target = sorted[0];
    const sources = sorted.slice(1);

    suggestions.push({
      key,
      reason: "same-mask",
      accountMask: group[0].mask,
      accountType: group[0].type,
      candidates,
      targetAccountId: target.accountId,
      targetAccountName: target.accountName,
      sourceAccountIds: sources.map((s) => s.accountId),
    });
  }

  // Institution-level suggestion: an institution where EVERY account is a
  // source (never a target) across the suggestions above — i.e. merging the
  // per-account suggestions would empty it out entirely.
  const sourceAccountToInstitution = new Map<string, string>();
  const targetInstitutions = new Set<string>();
  for (const s of suggestions) {
    targetInstitutions.add(
      candidatesInstitution(s, s.targetAccountId) ?? "",
    );
    for (const srcId of s.sourceAccountIds) {
      const instId = candidatesInstitution(s, srcId);
      if (instId) sourceAccountToInstitution.set(srcId, instId);
    }
  }
  const accountsByInstitution = new Map<string, string[]>();
  for (const a of acctRows) {
    const list = accountsByInstitution.get(a.institutionId) ?? [];
    list.push(a.id);
    accountsByInstitution.set(a.institutionId, list);
  }
  const fullyDuplicateInstitutions = new Set<string>();
  for (const [instId, acctIds] of accountsByInstitution) {
    if (acctIds.length === 0) continue;
    if (targetInstitutions.has(instId)) continue; // this institution is (partly) a merge target, keep it
    const allAreSources = acctIds.every((id) => sourceAccountToInstitution.get(id) === instId);
    if (allAreSources) fullyDuplicateInstitutions.add(instId);
  }
  for (const s of suggestions) {
    for (const srcId of s.sourceAccountIds) {
      const instId = candidatesInstitution(s, srcId);
      if (instId && fullyDuplicateInstitutions.has(instId)) {
        const inst = instById.get(instId);
        s.institutionFullyDuplicate = { institutionId: instId, institutionName: inst?.name ?? "Unknown" };
      }
    }
  }

  return suggestions;
}

function candidatesInstitution(s: MergeSuggestion, accountId: string): string | null {
  return s.candidates.find((c) => c.accountId === accountId)?.institutionId ?? null;
}

// --------------------------------------------------------------------------
// moveAccountToInstitution
// --------------------------------------------------------------------------

export interface MoveAccountResult {
  ok: true;
  accountId: string;
  fromInstitutionId: string;
  toInstitutionId: string;
  transactionsUpdated: number;
}

/**
 * Reparent an account (and its transactions' institution_id denorm) under a
 * different institution — for attaching a leftover manual account (e.g. a
 * history-only "Regular Savings" from CSV import) visually under a surviving
 * bank card, without merging it into any single other account.
 */
export async function moveAccountToInstitution(
  db: Db,
  owner: string,
  accountId: string,
  institutionId: string,
): Promise<MoveAccountResult> {
  const [acctRows, instRows] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.id, accountId)),
    db.select().from(institutions).where(eq(institutions.id, institutionId)),
  ]);
  const account = acctRows[0];
  const institution = instRows[0];
  if (!account) throw new Error(`Account ${accountId} not found.`);
  if (!institution) throw new Error(`Institution ${institutionId} not found.`);
  if (account.ownerEmail !== owner || institution.ownerEmail !== owner) {
    throw new Error("Account or institution does not belong to the current owner.");
  }

  const fromInstitutionId = account.institutionId;

  const [{ n: txCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));

  await db.update(accounts).set({ institutionId }).where(eq(accounts.id, accountId));
  await db
    .update(transactions)
    .set({ institutionId, updatedAt: nowIso() })
    .where(eq(transactions.accountId, accountId));

  return {
    ok: true,
    accountId,
    fromInstitutionId,
    toInstitutionId: institutionId,
    transactionsUpdated: Number(txCount ?? 0),
  };
}

// --------------------------------------------------------------------------
// removeInstitution
// --------------------------------------------------------------------------

export interface RemoveInstitutionResult {
  ok: true;
  institutionId: string;
  institutionName: string;
  mode: "kept-as-manual" | "deleted";
  plaidItemRemoved: boolean;
  plaidItemRemoveError: string | null;
  accountsAffected: number;
  transactionsDeleted: number;
}

/**
 * Remove a connection. Two modes:
 *   - keepDataAsManual (default): convert the institution to status='manual'
 *     (plaid_item_id rewritten to a unique 'manual:removed:<old>' key so a
 *     future re-link of the same bank doesn't collide with it), flip its
 *     accounts to is_manual=1, clear the access token — all transaction
 *     history is kept.
 *   - !keepDataAsManual (requires confirmDelete: true): hard-delete the
 *     institution, its accounts, and their transactions.
 * When the institution has a real Plaid access token and removeAtPlaid is
 * true, calls Plaid's /item/remove first (frees a limited trial connection
 * slot) — tolerates errors for already-dead/invalid items so a stale
 * connection can still be cleaned up locally.
 */
export async function removeInstitution(
  db: Db,
  owner: string,
  opts: {
    institutionId: string;
    keepDataAsManual: boolean;
    removeAtPlaid: boolean;
    confirmDelete?: boolean;
  },
): Promise<RemoveInstitutionResult> {
  const rows = await db.select().from(institutions).where(eq(institutions.id, opts.institutionId));
  const institution = rows[0];
  if (!institution) throw new Error(`Institution ${opts.institutionId} not found.`);
  if (institution.ownerEmail !== owner) {
    throw new Error("Institution does not belong to the current owner.");
  }
  if (!opts.keepDataAsManual && !opts.confirmDelete) {
    throw new Error(
      "Deleting all data for this institution requires confirmDelete: true. Pass keepDataAsManual: true (default) to keep transaction history instead.",
    );
  }

  const isRealItem = institution.status !== "manual" && institution.accessToken !== "manual_import";

  let plaidItemRemoved = false;
  let plaidItemRemoveError: string | null = null;
  if (isRealItem && opts.removeAtPlaid) {
    try {
      const { getPlaid } = await import("./plaid.js");
      const plaid = await getPlaid();
      await plaid.itemRemove({ access_token: institution.accessToken });
      plaidItemRemoved = true;
    } catch (err) {
      // Tolerate errors for already-dead/invalid items — the local cleanup
      // below still proceeds so the user isn't stuck with a zombie connection.
      plaidItemRemoveError = err instanceof Error ? err.message : String(err);
    }
  }

  const acctRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.institutionId, opts.institutionId));
  const acctIds = acctRows.map((a) => a.id);

  if (opts.keepDataAsManual) {
    await db
      .update(institutions)
      .set({
        status: "manual",
        accessToken: "manual_import",
        plaidItemId: `manual:removed:${institution.plaidItemId}`,
        syncCursor: null,
      })
      .where(eq(institutions.id, opts.institutionId));
    if (acctIds.length > 0) {
      await db
        .update(accounts)
        .set({ isManual: true })
        .where(inArray(accounts.id, acctIds));
    }
    return {
      ok: true,
      institutionId: opts.institutionId,
      institutionName: institution.name,
      mode: "kept-as-manual",
      plaidItemRemoved,
      plaidItemRemoveError,
      accountsAffected: acctIds.length,
      transactionsDeleted: 0,
    };
  }

  // Hard delete: transactions -> recurring/payment-plan refs cleared -> accounts -> institution.
  let transactionsDeleted = 0;
  if (acctIds.length > 0) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(inArray(transactions.accountId, acctIds));
    transactionsDeleted = Number(n ?? 0);
    await db.delete(transactions).where(inArray(transactions.accountId, acctIds));
    await db
      .update(recurring)
      .set({ accountId: null })
      .where(inArray(recurring.accountId, acctIds));
    await db
      .update(paymentPlans)
      .set({ cardAccountId: null })
      .where(inArray(paymentPlans.cardAccountId, acctIds));
    await db
      .update(paymentPlans)
      .set({ payFromAccountId: null })
      .where(inArray(paymentPlans.payFromAccountId, acctIds));
    await db.delete(accounts).where(inArray(accounts.id, acctIds));
  }
  await db.delete(institutions).where(eq(institutions.id, opts.institutionId));

  return {
    ok: true,
    institutionId: opts.institutionId,
    institutionName: institution.name,
    mode: "deleted",
    plaidItemRemoved,
    plaidItemRemoveError,
    accountsAffected: acctIds.length,
    transactionsDeleted,
  };
}
