/**
 * Duplicate transaction consolidation — finds and removes DUPLICATE rows
 * within a single account (not to be confused with account-merge.ts, which
 * dedupes rows that only collide as a SIDE EFFECT of merging two accounts
 * together). Real-world situation this solves (see AGENTS.md "Duplicates"
 * workflow):
 *
 *   (a) plaid-vs-plaid — merging two Plaid Items (e.g. the same Example Bank login
 *       connected twice, later consolidated into one) can leave TWO different
 *       plaid_transaction_ids for the SAME real-world charge on the SAME
 *       account (e.g. Hulu charged twice in the data even though it was only
 *       charged once in reality).
 *   (b) rm_-import-vs-plaid — a Rocket Money CSV import and Plaid's own
 *       history can disagree on the exact date (posted vs transaction date),
 *       so the exact-match dedupe in account-merge.ts/dedupe-account-transactions
 *       misses them.
 *
 * findDuplicateGroups groups CANDIDATES within one account: same amount_cents,
 * dates within a tolerance window, and a similar normalized merchant name.
 * consolidateDuplicates deletes the losers, re-links references, and carries
 * over note/category/flags the survivor is missing.
 *
 * IMPORTANT schema limitation: fp_transactions has no per-row marker for
 * "which Plaid Item this came from" — once two Items are merged onto one
 * account (merge-accounts), every Plaid-real row on that account looks
 * identical by provenance. So `DupeSummary.source` is only a two-way split
 * (`'plaid'` vs `'imported'`), and two Plaid-real rows can never be
 * conclusively told apart as "same original item" vs "different (now-merged)
 * item" — see the `bothPlaidReal` conservative guard below, which treats
 * every such pair as if it MIGHT be a same-item pending/posted transition
 * (which Plaid resolves on its own and should not be force-deduped) unless
 * one side is actually pending.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { accounts, institutions, transactions } from "../db/schema.js";
import { normalizeMerchantKey } from "./recurring.js";
import { isImportedTransactionId } from "./account-merge.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

export type Confidence = "high" | "medium";

export interface DupeCandidateRow {
  id: string;
  accountId: string;
  plaidTransactionId: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amountCents: number;
  pending: boolean;
  note: string | null;
  categoryId: string | null;
  categoryLocked: boolean;
  isIgnored: boolean;
  isTaxDeductible: boolean;
  recurringId: string | null;
  paymentPlanId: string | null;
  createdAt: string;
}

export interface DuplicateGroup {
  /** Stable id for this group so the UI can reference it across calls. */
  id: string;
  /** The survivor's account id. When crossAccount is true, losers may be on a different account. */
  accountId: string;
  /** True when this group spans more than one account (only possible with crossAccounts:true). */
  crossAccount: boolean;
  confidence: Confidence;
  /** The row that will be kept. */
  survivor: DupeSummary;
  /** Rows that will be deleted, carrying over fields the survivor lacks. */
  losers: DupeSummary[];
}

export interface DupeSummary {
  id: string;
  accountId: string;
  date: string | null;
  name: string | null;
  merchantName: string | null;
  amountCents: number;
  /**
   * 'plaid' = a real Plaid-synced row (from whichever Item currently owns
   * this account); 'imported' = a Rocket Money CSV row (plaid_transaction_id
   * starts 'rm_'). NOTE: fp_transactions has no per-row "which Plaid Item"
   * marker — once two Items are merged onto one account (merge-accounts),
   * every Plaid-real row on that account is indistinguishable from any
   * other by source Item. So this is a two-way split, not three: we cannot
   * tell "this account's current item" apart from "a different item" after
   * the fact, only Plaid-real vs CSV-imported.
   */
  source: "plaid" | "imported";
  pending: boolean;
  note: string | null;
  categoryId: string | null;
}

const DATE_TOLERANCE_DAYS = 3;

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db_ = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(da - db_) / 86_400_000;
}

/** Similar-merchant check: exact normalized-key match, or one contains the other. */
function similarMerchant(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * True when both raw names contain a shared "long" word token (5+ letters,
 * case-insensitive) — used to bump a cross-account group's confidence to
 * 'high' (e.g. both names contain "hulu"/"netflix"/etc.), on top of the
 * normalized-merchant-key match. Guards against bumping confidence purely
 * off short generic words ("the", "com", "inc").
 */
function sharesLongToken(aRaw: string, bRaw: string): boolean {
  const tokensOf = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z]+/g)
        .filter((t) => t.length >= 5),
    );
  const aTokens = tokensOf(aRaw);
  const bTokens = tokensOf(bRaw);
  for (const t of aTokens) {
    if (bTokens.has(t)) return true;
  }
  return false;
}

/**
 * Loose-normalize for the "raw name" cross-check: lowercase + collapse
 * whitespace/punctuation but PRESERVE digits — unlike normalizeMerchantKey
 * (which strips store numbers/dates for recurring-merchant grouping),
 * digit sequences here are often the ONLY thing distinguishing two
 * genuinely different transactions, e.g. "Online Xfer Transfer from SV
 * x0681" vs "...SV x0342" (transfers from two different source accounts,
 * same amount/date/generic-prefix, NOT a duplicate of each other).
 */
function looseNormalizePreservingDigits(name: string | null | undefined): string {
  if (!name) return "";
  let s = name.toLowerCase();
  // Strip masked-card-number tokens (mixed digit + long x-run, e.g.
  // "3861xxxxxxxxxx9093") entirely before the general normalize below — a
  // masked PAN changes on card reissue for the SAME real charge, so two
  // otherwise-identical rows must not be kept apart just because their masked
  // segments differ in digits or x-run length (see normalizeMerchantKey for
  // the twin fix on the merchant-KEY layer). A genuine short reference like
  // "x0681" (no long x-run) is intentionally preserved by the general
  // alphanumeric-preserving normalize below.
  s = s.replace(/[a-z0-9]*\d[a-z0-9]*x{4,}[a-z0-9]*|[a-z0-9]*x{4,}[a-z0-9]*\d[a-z0-9]*/g, " ");
  return s
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True duplicate-candidate check: the normalized merchant KEY must match
 * (normalizeMerchantKey equality or containment, per spec), AND the raw
 * name/merchant text (digits preserved) must also be equal or one must
 * contain the other. This second check is what prevents two distinct
 * transactions whose only difference is a trailing account/reference number
 * (which normalizeMerchantKey deliberately strips) from being merged.
 */
function candidatesAreSimilar(aRaw: string, bRaw: string, aKey: string, bKey: string): boolean {
  if (!similarMerchant(aKey, bKey)) return false;
  const aLoose = looseNormalizePreservingDigits(aRaw);
  const bLoose = looseNormalizePreservingDigits(bRaw);
  if (!aLoose || !bLoose) return aLoose === bLoose;
  return aLoose === bLoose || aLoose.includes(bLoose) || bLoose.includes(aLoose);
}

/** Minimum occurrences (same account+merchant-key+amount) to call it a series, not a duplicate anomaly. */
const RECURRING_SERIES_MIN_OCCURRENCES = 3;
/** Gaps at or below this are "duplicate territory" — a real recurring series' gaps average above it. */
const RECURRING_SERIES_MIN_AVG_GAP_DAYS = DATE_TOLERANCE_DAYS + 1;

/**
 * Identify rows that belong to a periodic series (3+ occurrences, same
 * account + normalized merchant key + amount, average gap between
 * consecutive occurrences comfortably larger than the dedupe date
 * tolerance) so they're excluded from duplicate candidacy entirely. A real
 * accidental duplicate is 2 (occasionally a couple more, e.g. a triple
 * webhook replay) rows close together — a long, roughly-evenly-spaced run is
 * a recurring bill/transfer/subscription, which is `detect-recurring`'s
 * domain, not this tool's.
 */
function findRecurringSeriesRowIds(candidates: DupeCandidateRow[]): Set<string> {
  const byKey = new Map<string, DupeCandidateRow[]>();
  for (const c of candidates) {
    if (!c.date) continue;
    const merchantKey = normalizeMerchantKey(c.merchantName || c.name);
    if (!merchantKey) continue;
    const key = `${c.accountId}::${merchantKey}::${c.amountCents}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }

  const seriesRowIds = new Set<string>();
  for (const [, rows] of byKey) {
    if (rows.length < RECURRING_SERIES_MIN_OCCURRENCES) continue;
    const sorted = [...rows].sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1].date!, sorted[i].date!));
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avgGap >= RECURRING_SERIES_MIN_AVG_GAP_DAYS) {
      for (const r of rows) seriesRowIds.add(r.id);
    }
  }
  return seriesRowIds;
}

function sourceFor(row: DupeCandidateRow): DupeSummary["source"] {
  return isImportedTransactionId(row.plaidTransactionId) ? "imported" : "plaid";
}

/** Authority rank for choosing the survivor: lower wins. Plaid-real > CSV-imported. */
function authorityRank(source: DupeSummary["source"]): number {
  return source === "plaid" ? 0 : 1;
}

function toSummary(row: DupeCandidateRow, source: DupeSummary["source"]): DupeSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    date: row.date,
    name: row.name,
    merchantName: row.merchantName,
    amountCents: row.amountCents,
    source,
    pending: row.pending,
    note: row.note,
    categoryId: row.categoryId,
  };
}

/**
 * Given a cluster of candidate rows (all sharing amount, within the date
 * tolerance and merchant-similar), decide the confidence and pick a survivor.
 * `accountSyncRank` maps accountId -> a rank where LOWER is more-recently-
 * synced (used only for the cross-account survivor tie-break).
 */
function buildGroupFromCluster(
  cluster: DupeCandidateRow[],
  accountSyncRank: Map<string, number>,
): { confidence: Confidence; survivorRow: DupeCandidateRow; loserRows: DupeCandidateRow[]; crossAccount: boolean } {
  const crossAccount = new Set(cluster.map((c) => c.accountId)).size > 1;

  // Determine confidence: exact date+amount+merchant match across the WHOLE
  // cluster => high; otherwise (any pair used the ±3d tolerance or fuzzy
  // merchant containment) => medium. Cross-account clusters are capped at
  // 'medium' by default (legit same-day/same-amount cross-account txns exist,
  // e.g. transfers) EXCEPT bumped back to 'high' when the normalized merchant
  // matches AND the raw names share a long token AND amounts are equal
  // (guaranteed true — same amount bucket) AND every pair is within 1 day.
  const merchantKeys = cluster.map((c) => normalizeMerchantKey(c.merchantName || c.name));
  const allSameDate = cluster.every((c) => c.date === cluster[0].date);
  const allExactMerchant = merchantKeys.every((m) => m === merchantKeys[0]);
  let confidence: Confidence = allSameDate && allExactMerchant ? "high" : "medium";

  if (crossAccount) {
    const withinOneDay = cluster.every((c) =>
      cluster.every((d) => !c.date || !d.date || daysBetween(c.date, d.date) <= 1),
    );
    const allShareLongToken = cluster.every((c) =>
      cluster.every((d) => {
        if (c.id === d.id) return true;
        return sharesLongToken(c.merchantName || c.name || "", d.merchantName || d.name || "");
      }),
    );
    confidence = allExactMerchant && allShareLongToken && withinOneDay ? "high" : "medium";
  }

  // Rank by authority: Plaid-real > CSV-imported; then (cross-account only)
  // the account whose institution was synced most recently; tie-break by
  // earliest createdAt (the original/oldest row wins ties).
  const ranked = [...cluster].sort((x, y) => {
    const rx = authorityRank(sourceFor(x));
    const ry = authorityRank(sourceFor(y));
    if (rx !== ry) return rx - ry;
    if (crossAccount) {
      const sx = accountSyncRank.get(x.accountId) ?? Number.MAX_SAFE_INTEGER;
      const sy = accountSyncRank.get(y.accountId) ?? Number.MAX_SAFE_INTEGER;
      if (sx !== sy) return sx - sy;
    }
    return x.createdAt.localeCompare(y.createdAt);
  });

  return { confidence, survivorRow: ranked[0], loserRows: ranked.slice(1), crossAccount };
}

/** Pairwise duplicate-candidate test shared by the same-account and cross-account passes. */
function isDuplicateCandidatePair(a: DupeCandidateRow, b: DupeCandidateRow): boolean {
  if (!a.date || !b.date) return false;
  if (a.plaidTransactionId === b.plaidTransactionId) return false; // impossible dupe of self
  const withinDates = daysBetween(a.date, b.date) <= DATE_TOLERANCE_DAYS;
  if (!withinDates) return false;
  const merchantA = normalizeMerchantKey(a.merchantName || a.name);
  const merchantB = normalizeMerchantKey(b.merchantName || b.name);
  if (!candidatesAreSimilar(a.merchantName || a.name || "", b.merchantName || b.name || "", merchantA, merchantB)) {
    return false;
  }

  // Both rows are Plaid-real AND on the same account. The schema has no
  // per-row "which Item" marker, so two Plaid-real rows on the SAME account
  // can NEVER be told apart as "same item" vs "different (now-merged) item"
  // after the fact — treat every such pair conservatively as if it might be
  // the same item's own pending->posted transition (which Plaid handles
  // itself and should NOT be deduped as a true duplicate), only allowing it
  // through when one side is actually pending and dates are within 2 days.
  // Cross-account pairs don't have this ambiguity (different accounts can't
  // be the "same Item's pending/posted transition" of one row), so this
  // guard only applies when both rows share an account.
  const bothPlaidReal = !isImportedTransactionId(a.plaidTransactionId) && !isImportedTransactionId(b.plaidTransactionId);
  if (bothPlaidReal && a.accountId === b.accountId) {
    const onePending = a.pending !== b.pending && (a.pending || b.pending);
    if (!onePending) return false;
    if (daysBetween(a.date, b.date) > 2) return false;
  }
  return true;
}

/** Union-find style clustering over a bucket of same-amount candidates. Returns clusters of size >= 2. */
function clusterBucket(bucket: DupeCandidateRow[]): DupeCandidateRow[][] {
  const clusters: DupeCandidateRow[][] = [];
  const used = new Set<string>();
  for (let i = 0; i < bucket.length; i++) {
    if (used.has(bucket[i].id)) continue;
    const cluster: DupeCandidateRow[] = [bucket[i]];
    used.add(bucket[i].id);

    for (let j = i + 1; j < bucket.length; j++) {
      const b = bucket[j];
      if (used.has(b.id)) continue;
      const matchesAny = cluster.some((a) => isDuplicateCandidatePair(a, b));
      if (matchesAny) {
        cluster.push(b);
        used.add(b.id);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }
  return clusters;
}

/**
 * Find duplicate groups within one owner's transactions, optionally scoped to
 * one account. Grouping key: same amount_cents, dates within
 * DATE_TOLERANCE_DAYS, similar normalized merchant. Same-item pending/posted
 * pairs are allowed ONLY when one side is pending (Plaid usually resolves
 * these itself; being conservative avoids false-merging two genuinely
 * separate same-day/same-amount charges from the SAME item).
 *
 * `crossAccounts` (default false) additionally looks for duplicate candidates
 * across DIFFERENT accounts within the same profile — e.g. the same real Hulu
 * charge landing on two now-separate "copies" of a Example Bank account
 * (two Plaid Items for the same login, only one of which got merged). These
 * cross-account groups are capped at 'medium' confidence by default (a
 * same-day/same-amount charge on two different accounts can legitimately be
 * unrelated, e.g. a transfer), bumped to 'high' only when the normalized
 * merchant matches AND both raw names share a long token AND every pair in
 * the cluster is within 1 day.
 */
export async function findDuplicateGroups(
  db: Db,
  owner: string,
  opts: { accountId?: string; limit?: number; crossAccounts?: boolean } = {},
): Promise<DuplicateGroup[]> {
  const conditions = [eq(transactions.ownerEmail, owner)];
  if (opts.accountId) conditions.push(eq(transactions.accountId, opts.accountId));

  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      plaidTransactionId: transactions.plaidTransactionId,
      date: transactions.date,
      name: transactions.name,
      merchantName: transactions.merchantName,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
      note: transactions.note,
      categoryId: transactions.categoryId,
      categoryLocked: transactions.categoryLocked,
      isIgnored: transactions.isIgnored,
      isTaxDeductible: transactions.isTaxDeductible,
      recurringId: transactions.recurringId,
      paymentPlanId: transactions.paymentPlanId,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(asc(transactions.accountId), asc(transactions.date));

  const candidates: DupeCandidateRow[] = rows.map((r) => ({
    ...r,
    pending: Boolean(r.pending),
    categoryLocked: Boolean(r.categoryLocked),
    isIgnored: Boolean(r.isIgnored),
    isTaxDeductible: Boolean(r.isTaxDeductible),
  }));

  // Group by account first (duplicates only make sense within one account,
  // or — with crossAccounts — across accounts in the same profile scan).
  const byAccount = new Map<string, DupeCandidateRow[]>();
  for (const c of candidates) {
    const list = byAccount.get(c.accountId) ?? [];
    list.push(c);
    byAccount.set(c.accountId, list);
  }

  // Recurring-series guard: a periodic transfer/bill/subscription (e.g. a
  // recurring $500 savings transfer every ~5 days, rent every month) shares
  // the same account+merchant+amount across MANY occurrences — exactly the
  // same signal this tool uses for duplicates. Without this guard, every
  // adjacent pair in a long recurring series gets flagged as a "duplicate"
  // even though each occurrence is a genuinely separate real transaction.
  // Detect series of 3+ occurrences (same account, same normalized merchant
  // key, same amount) whose gaps are consistently LARGER than the dedupe
  // date tolerance and roughly even (a real duplicate pair is an anomaly —
  // one unusually-close extra occurrence right next to a normal one, not a
  // long evenly-spaced run) — exclude every row in such a series from
  // candidacy entirely; `detect-recurring` is the right tool for these. This
  // guard stays PER-ACCOUNT even in cross-account mode — a recurring series
  // is inherently an account-scoped pattern.
  const recurringSeriesRowIds = findRecurringSeriesRowIds(candidates);
  const nonSeriesCandidates = candidates.filter((r) => !recurringSeriesRowIds.has(r.id));

  // Account -> institution lastSyncedAt rank (lower = more recently synced),
  // only needed for the cross-account survivor tie-break.
  const accountSyncRank = new Map<string, number>();
  if (opts.crossAccounts) {
    const acctRows = await db
      .select({ id: accounts.id, institutionId: accounts.institutionId })
      .from(accounts)
      .where(eq(accounts.ownerEmail, owner));
    const instRows = await db
      .select({ id: institutions.id, lastSyncedAt: institutions.lastSyncedAt })
      .from(institutions)
      .where(eq(institutions.ownerEmail, owner));
    const lastSyncedById = new Map(instRows.map((i) => [i.id, i.lastSyncedAt]));
    for (const a of acctRows) {
      const syncedAt = lastSyncedById.get(a.institutionId);
      // Encode as a sortable rank: most-recent lastSyncedAt -> lowest rank.
      // Missing/never-synced accounts rank last (Number.MAX_SAFE_INTEGER).
      accountSyncRank.set(a.id, syncedAt ? -new Date(syncedAt).getTime() : Number.MAX_SAFE_INTEGER);
    }
  }

  const groups: DuplicateGroup[] = [];
  let groupCounter = 0;
  const usedInCrossGroup = new Set<string>();

  for (const [accountId, acctRowsAll] of byAccount) {
    const acctRows = acctRowsAll.filter((r) => !recurringSeriesRowIds.has(r.id));
    // Bucket by amount first (cheap exact key), then compare within bucket.
    const byAmount = new Map<number, DupeCandidateRow[]>();
    for (const r of acctRows) {
      const list = byAmount.get(r.amountCents) ?? [];
      list.push(r);
      byAmount.set(r.amountCents, list);
    }

    for (const [, bucket] of byAmount) {
      if (bucket.length < 2) continue;
      for (const cluster of clusterBucket(bucket)) {
        const { confidence, survivorRow, loserRows } = buildGroupFromCluster(cluster, accountSyncRank);
        groupCounter++;
        groups.push({
          id: `dupgrp_${accountId}_${groupCounter}`,
          accountId,
          crossAccount: false,
          confidence,
          survivor: toSummary(survivorRow, sourceFor(survivorRow)),
          losers: loserRows.map((r) => toSummary(r, sourceFor(r))),
        });
        for (const r of cluster) usedInCrossGroup.add(r.id);
      }
    }
  }

  // Cross-account pass: bucket by amount across ALL accounts together, then
  // cluster — but only keep clusters that actually span more than one
  // account (same-account clusters were already found above) and whose rows
  // weren't already consumed by a same-account group.
  if (opts.crossAccounts) {
    const remaining = nonSeriesCandidates.filter((r) => !usedInCrossGroup.has(r.id));
    const byAmountAllAccounts = new Map<number, DupeCandidateRow[]>();
    for (const r of remaining) {
      const list = byAmountAllAccounts.get(r.amountCents) ?? [];
      list.push(r);
      byAmountAllAccounts.set(r.amountCents, list);
    }

    for (const [, bucket] of byAmountAllAccounts) {
      if (bucket.length < 2) continue;
      for (const cluster of clusterBucket(bucket)) {
        const spansAccounts = new Set(cluster.map((c) => c.accountId)).size > 1;
        if (!spansAccounts) continue; // already covered by the same-account pass
        const { confidence, survivorRow, loserRows, crossAccount } = buildGroupFromCluster(cluster, accountSyncRank);
        groupCounter++;
        groups.push({
          id: `dupgrp_x_${groupCounter}`,
          accountId: survivorRow.accountId,
          crossAccount,
          confidence,
          survivor: toSummary(survivorRow, sourceFor(survivorRow)),
          losers: loserRows.map((r) => toSummary(r, sourceFor(r))),
        });
      }
    }
  }

  const limit = opts.limit ?? 200;
  return groups.slice(0, limit);
}

export interface ConsolidateResult {
  ok: true;
  groupsConsidered: number;
  transactionsRemoved: number;
  recurringRelinked: number;
  paymentPlansRelinked: number;
}

/**
 * Delete losers from duplicate groups (re-derived fresh so ids stay valid),
 * re-linking recurring/payment-plan references onto the survivor and carrying
 * over note/category/flags the survivor is missing.
 */
export async function consolidateDuplicates(
  db: Db,
  owner: string,
  opts: { accountId?: string; groupIds?: string[]; minConfidence?: Confidence; crossAccounts?: boolean } = {},
): Promise<ConsolidateResult> {
  const minConfidence = opts.minConfidence ?? "high";
  const allGroups = await findDuplicateGroups(db, owner, {
    accountId: opts.accountId,
    limit: 1000,
    crossAccounts: opts.crossAccounts,
  });

  const wantedGroups = allGroups.filter((g) => {
    if (opts.groupIds && opts.groupIds.length > 0 && !opts.groupIds.includes(g.id)) return false;
    if (minConfidence === "high") return g.confidence === "high";
    return true; // 'medium' threshold includes both high and medium
  });

  let transactionsRemoved = 0;
  let recurringRelinked = 0;
  let paymentPlansRelinked = 0;

  for (const group of wantedGroups) {
    const survivorId = group.survivor.id;
    const loserIds = group.losers.map((l) => l.id);
    if (loserIds.length === 0) continue;

    // Fetch full rows fresh (fields needed for carry-over + relinking).
    const rows = await db
      .select()
      .from(transactions)
      .where(inArray(transactions.id, [survivorId, ...loserIds]));
    const survivor = rows.find((r) => r.id === survivorId);
    const losers = rows.filter((r) => loserIds.includes(r.id));
    if (!survivor) continue;

    const needsNote = !survivor.note && losers.some((l) => l.note);
    const needsCategory = !survivor.categoryId && losers.some((l) => l.categoryId);
    const carryNote = needsNote ? losers.find((l) => l.note)?.note ?? null : undefined;
    const carryCategoryLoser = needsCategory ? losers.find((l) => l.categoryId) : undefined;
    const needsTaxDeductible = !survivor.isTaxDeductible && losers.some((l) => l.isTaxDeductible);

    if (needsNote || needsCategory || needsTaxDeductible) {
      await db
        .update(transactions)
        .set({
          ...(needsNote ? { note: carryNote } : {}),
          ...(needsCategory && carryCategoryLoser
            ? { categoryId: carryCategoryLoser.categoryId, categoryLocked: carryCategoryLoser.categoryLocked }
            : {}),
          ...(needsTaxDeductible ? { isTaxDeductible: true } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(transactions.id, survivorId));
    }

    // Re-link recurring/payment-plan references from losers onto the survivor
    // (only if the survivor doesn't already have one).
    const loserRecurringId = losers.find((l) => l.recurringId)?.recurringId;
    if (loserRecurringId && !survivor.recurringId) {
      await db
        .update(transactions)
        .set({ recurringId: loserRecurringId })
        .where(eq(transactions.id, survivorId));
      recurringRelinked++;
    }
    const loserPlanId = losers.find((l) => l.paymentPlanId)?.paymentPlanId;
    if (loserPlanId && !survivor.paymentPlanId) {
      await db
        .update(transactions)
        .set({ paymentPlanId: loserPlanId })
        .where(eq(transactions.id, survivorId));
      paymentPlansRelinked++;
    }

    // Any OTHER rows (recurring/payment-plans/other tables) that referenced a
    // loser transaction id directly don't exist in this schema (links are
    // transaction -> recurring/plan, not the reverse), so no further re-link
    // pass is needed beyond the transactions row itself.

    await db.delete(transactions).where(inArray(transactions.id, loserIds));
    transactionsRemoved += loserIds.length;
  }

  return {
    ok: true,
    groupsConsidered: wantedGroups.length,
    transactionsRemoved,
    recurringRelinked,
    paymentPlansRelinked,
  };
}
