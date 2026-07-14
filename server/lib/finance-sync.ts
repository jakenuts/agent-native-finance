/**
 * Core Plaid → DB sync logic. Framework-light (takes a db instance) so it can
 * be driven from actions, a scheduled job, or a webhook. Portable upserts
 * (select-then-write) so it runs on SQLite and Postgres alike.
 */
import { eq } from "drizzle-orm";
import { getPlaid, toCents, CountryCode } from "./plaid.js";
import { accounts, categories, institutions, recurring, rules, transactions } from "../db/schema.js";
import { resolveCategory } from "./categorize.js";
import { normalizeMerchantKey } from "./recurring.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;
type PlaidClient = Awaited<ReturnType<typeof getPlaid>>;
type PlaidAccounts = Awaited<ReturnType<PlaidClient["accountsGet"]>>["data"]["accounts"];

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a `/transactions/refresh` (which forces Plaid to re-poll the bank), how
 * long to wait before pulling the cursor delta so the freshly-fetched
 * transactions are ready. Plaid's refresh is async (it also fires a
 * SYNC_UPDATES_AVAILABLE webhook when done, which is our backstop) — this
 * settle just lets the common case land in the SAME sync pass. Override via
 * FINANCE_REFRESH_SETTLE_MS.
 */
const REFRESH_SETTLE_MS = Number(process.env.FINANCE_REFRESH_SETTLE_MS ?? 12_000);

/**
 * Like `toCents`, but preserves a true `null` instead of coercing it to 0.
 * Plaid returns `available: null` for account types where "available to
 * spend" isn't a meaningful concept (investment/retirement accounts, CDs,
 * loans) — collapsing that to 0 cents would make the UI's "lead with
 * available balance" display show a misleading $0.00 for e.g. a 401k.
 * `currentBalanceCents` intentionally keeps using plain `toCents` (0 is the
 * right fallback for the accounting/net-worth total), but
 * `availableBalanceCents` needs the null preserved end-to-end.
 */
function toCentsOrNull(amount: number | null | undefined): number | null {
  if (amount == null) return null;
  return Math.round(amount * 100);
}

/** Look up a human institution name from a Plaid institution_id. */
async function institutionName(institutionId?: string | null): Promise<string> {
  if (!institutionId) return "Unknown institution";
  try {
    const plaid = await getPlaid();
    const res = await plaid.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    return res.data.institution.name ?? institutionId;
  } catch {
    return institutionId;
  }
}

/**
 * Register a freshly-exchanged access token: create the institution row (if
 * new), pull its accounts, and run an initial transaction sync.
 */
export async function onboardAccessToken(
  db: Db,
  opts: {
    ownerEmail: string;
    accessToken: string;
    itemId: string;
    plaidInstitutionId?: string | null;
    /** Profile applied to this institution's newly discovered accounts. */
    defaultProfile?: "personal" | "business";
  },
): Promise<{ institutionId: string; accounts: number; transactions: number }> {
  const existing = await db
    .select()
    .from(institutions)
    .where(eq(institutions.plaidItemId, opts.itemId));

  let institutionId: string;
  if (existing.length > 0) {
    institutionId = existing[0].id;
    await db
      .update(institutions)
      .set({ accessToken: opts.accessToken, status: "connected" })
      .where(eq(institutions.id, institutionId));
  } else {
    institutionId = crypto.randomUUID();
    await db.insert(institutions).values({
      id: institutionId,
      ownerEmail: opts.ownerEmail,
      plaidItemId: opts.itemId,
      plaidInstitutionId: opts.plaidInstitutionId ?? null,
      name: await institutionName(opts.plaidInstitutionId),
      accessToken: opts.accessToken,
      status: "connected",
      defaultProfile: opts.defaultProfile ?? "personal",
      createdAt: nowIso(),
    });
  }

  const acctCount = await upsertAccounts(db, {
    ownerEmail: opts.ownerEmail,
    institutionId,
    accessToken: opts.accessToken,
  });
  const txCount = await syncInstitution(db, institutionId);
  return { institutionId, accounts: acctCount, transactions: txCount };
}

/** Pull and upsert all accounts for an institution. */
export async function upsertAccounts(
  db: Db,
  opts: { ownerEmail: string; institutionId: string; accessToken: string },
): Promise<number> {
  const plaid = await getPlaid();
  const res = await plaid.accountsGet({ access_token: opts.accessToken });

  // Newly discovered accounts inherit the institution's default_profile.
  const instRows = await db
    .select({ defaultProfile: institutions.defaultProfile })
    .from(institutions)
    .where(eq(institutions.id, opts.institutionId));
  const defaultProfile = instRows[0]?.defaultProfile ?? "personal";

  for (const a of res.data.accounts) {
    const row = {
      ownerEmail: opts.ownerEmail,
      institutionId: opts.institutionId,
      plaidAccountId: a.account_id,
      name: a.name ?? null,
      officialName: a.official_name ?? null,
      mask: a.mask ?? null,
      type: a.type ?? null,
      subtype: a.subtype ?? null,
      currentBalanceCents: toCents(a.balances.current),
      availableBalanceCents: toCentsOrNull(a.balances.available),
      isoCurrency: a.balances.iso_currency_code ?? null,
    };
    const found = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.plaidAccountId, a.account_id));
    if (found.length > 0) {
      await db.update(accounts).set(row).where(eq(accounts.id, found[0].id));
    } else {
      await db
        .insert(accounts)
        .values({ id: crypto.randomUUID(), ...row, profile: defaultProfile });
    }
  }
  return res.data.accounts.length;
}

/**
 * Refresh CURRENT/AVAILABLE balances for every account at an institution,
 * without touching transactions. Prefers `accountsBalanceGet` (Plaid's
 * real-time balance refresh endpoint — forces a fresh pull from the
 * institution rather than serving Plaid's cache), falling back to
 * `accountsGet` if that call fails (some institutions rate-limit real-time
 * balance refreshes). Returns how many accounts were updated and which path
 * was used, for logging/telemetry. No-op for manual (non-Plaid) institutions.
 */
export async function refreshAccountBalances(
  db: Db,
  institutionId: string,
): Promise<{ updated: number; path: "balance" | "accounts" | "skipped" }> {
  const rows = await db
    .select()
    .from(institutions)
    .where(eq(institutions.id, institutionId));
  if (rows.length === 0) throw new Error(`Institution ${institutionId} not found`);
  const inst = rows[0];

  if (inst.status === "manual" || inst.accessToken === "manual_import") {
    return { updated: 0, path: "skipped" };
  }

  const plaid = await getPlaid();
  let path: "balance" | "accounts" = "balance";
  let plaidAccounts: PlaidAccounts;
  try {
    const res = await plaid.accountsBalanceGet({ access_token: inst.accessToken });
    plaidAccounts = res.data.accounts;
  } catch {
    // Some institutions rate-limit real-time balance refreshes; fall back to
    // the (possibly cached, but still institution-backed) accountsGet.
    path = "accounts";
    const res = await plaid.accountsGet({ access_token: inst.accessToken });
    plaidAccounts = res.data.accounts;
  }

  const acctRows = await db
    .select({ id: accounts.id, plaidAccountId: accounts.plaidAccountId })
    .from(accounts)
    .where(eq(accounts.institutionId, institutionId));
  const acctByPlaid = new Map(acctRows.map((r) => [r.plaidAccountId, r.id]));

  let updated = 0;
  for (const a of plaidAccounts) {
    const accountId = acctByPlaid.get(a.account_id);
    if (!accountId) continue; // not yet known locally; a full upsertAccounts will pick it up
    await db
      .update(accounts)
      .set({
        currentBalanceCents: toCents(a.balances.current),
        availableBalanceCents: toCentsOrNull(a.balances.available),
        isoCurrency: a.balances.iso_currency_code ?? null,
      })
      .where(eq(accounts.id, accountId));
    updated++;
  }

  return { updated, path };
}

/**
 * Force Plaid to re-poll the bank for TRANSACTIONS right now via
 * `/transactions/refresh`. Plaid's `/transactions/sync` only returns Plaid's
 * already-cached delta — it never re-checks the bank — so without this, an
 * institution that Plaid only refreshes ~once a day (e.g. Example Bank)
 * lags the bank by up to a day even though "Sync now" appears to run.
 *
 * This is asynchronous on Plaid's side: it completes shortly after and fires a
 * SYNC_UPDATES_AVAILABLE webhook (our ingestion backstop). Callers that want
 * the fresh rows in the same pass should wait `REFRESH_SETTLE_MS`, then run the
 * cursor sync. Tolerant of errors (rate limits, transient outages) — a failed
 * poke just means we fall back to the cached delta, never a thrown sync.
 * No-op for manual (non-Plaid) institutions.
 */
export async function refreshInstitutionTransactions(
  db: Db,
  institutionId: string,
): Promise<{ refreshed: boolean; reason?: string }> {
  const rows = await db
    .select({ accessToken: institutions.accessToken, status: institutions.status })
    .from(institutions)
    .where(eq(institutions.id, institutionId));
  if (rows.length === 0) throw new Error(`Institution ${institutionId} not found`);
  const inst = rows[0];
  if (inst.status === "manual" || inst.accessToken === "manual_import") {
    return { refreshed: false, reason: "manual" };
  }
  try {
    const plaid = await getPlaid();
    await plaid.transactionsRefresh({ access_token: inst.accessToken });
    return { refreshed: true };
  } catch (err: unknown) {
    // Rate-limited or transient — proceed with the cached delta. Plaid caps
    // on-demand refreshes per Item; a skipped poke is not a sync failure.
    const code =
      (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
      (err instanceof Error ? err.message : "unknown");
    console.warn(`[finance-sync] transactions refresh skipped for ${institutionId}: ${code}`);
    return { refreshed: false, reason: code };
  }
}

/** Poke every connected (non-manual) institution for an owner to re-pull from the bank. */
export async function refreshAllTransactions(
  db: Db,
  ownerEmail: string,
): Promise<{ refreshed: number; attempted: number }> {
  const insts = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.ownerEmail, ownerEmail));
  let refreshed = 0;
  for (const i of insts) {
    const r = await refreshInstitutionTransactions(db, i.id);
    if (r.refreshed) refreshed++;
  }
  return { refreshed, attempted: insts.length };
}

/**
 * Cursor-based transaction sync for a single institution.
 *
 * `forceBankRefresh` (default false): when true, first calls
 * `refreshInstitutionTransactions` to make Plaid re-poll the bank, waits
 * `REFRESH_SETTLE_MS`, then pulls — so on-demand ("Sync now") and scheduled
 * syncs get today's posted transactions instead of Plaid's stale cache. The
 * webhook path leaves this false (it's already reacting to a Plaid update, and
 * poking again would loop refresh → webhook → refresh).
 */
export async function syncInstitution(
  db: Db,
  institutionId: string,
  opts?: { forceBankRefresh?: boolean },
): Promise<number> {
  if (opts?.forceBankRefresh) {
    const r = await refreshInstitutionTransactions(db, institutionId);
    // Only wait when we actually triggered a bank re-pull (skip for manual
    // institutions and rate-limited pokes — there's no fresh data coming).
    if (r.refreshed) await sleep(REFRESH_SETTLE_MS);
  }
  const rows = await db
    .select()
    .from(institutions)
    .where(eq(institutions.id, institutionId));
  if (rows.length === 0) throw new Error(`Institution ${institutionId} not found`);
  const inst = rows[0];

  // Manual (RM-CSV-imported) institutions have no real Plaid access token —
  // they're not backed by a Plaid Item, so there's nothing to sync.
  if (inst.status === "manual" || inst.accessToken === "manual_import") {
    return 0;
  }

  // Map plaid account_id -> our account id (and its profile) for this institution.
  const acctRows = await db
    .select({ id: accounts.id, plaidAccountId: accounts.plaidAccountId, profile: accounts.profile })
    .from(accounts)
    .where(eq(accounts.institutionId, institutionId));
  const acctByPlaid = new Map(acctRows.map((r) => [r.plaidAccountId, r.id]));
  const profileByAcctId = new Map(acctRows.map((r) => [r.id, r.profile]));

  // Categorization context: enabled rules + categories for this owner. Every
  // added/modified (non-locked) transaction gets a category via
  // resolveCategory (rule > PFC mapping > null).
  const ownerCategories = await db
    .select({
      id: categories.id,
      name: categories.name,
      categoryGroup: categories.categoryGroup,
    })
    .from(categories)
    .where(eq(categories.ownerEmail, inst.ownerEmail));
  const ownerRules = await db
    .select()
    .from(rules)
    .where(eq(rules.ownerEmail, inst.ownerEmail));

  // Recurring-linking context: active recurrings keyed by merchant_key, so
  // every added/modified transaction that matches gets recurring_id set and
  // the recurring's last_amount_cents/last_seen_date refreshed. Cheap
  // in-memory lookup, same batching approach as categorization above.
  const ownerRecurrings = await db
    .select({
      id: recurring.id,
      merchantKey: recurring.merchantKey,
      isActive: recurring.isActive,
    })
    .from(recurring)
    .where(eq(recurring.ownerEmail, inst.ownerEmail));
  const recurringByMerchantKey = new Map(
    ownerRecurrings
      .filter((r) => r.isActive && r.merchantKey)
      .map((r) => [r.merchantKey as string, r.id]),
  );
  const recurringUpdates = new Map<string, { lastAmountCents: number; lastSeenDate: string }>();

  let cursor = inst.syncCursor ?? undefined;
  let hasMore = true;
  let changed = 0;
  const plaid = await getPlaid();

  while (hasMore) {
    const res = await plaid.transactionsSync({
      access_token: inst.accessToken,
      cursor,
    });
    const data = res.data;

    for (const t of [...data.added, ...data.modified]) {
      const accountId = acctByPlaid.get(t.account_id) ?? null;
      if (!accountId) continue; // account not yet known; will backfill next run
      const row = {
        ownerEmail: inst.ownerEmail,
        accountId,
        institutionId,
        plaidTransactionId: t.transaction_id,
        date: t.date ?? null,
        authorizedDate: t.authorized_date ?? null,
        name: t.name ?? null,
        merchantName: t.merchant_name ?? null,
        amountCents: toCents(t.amount),
        isoCurrency: t.iso_currency_code ?? null,
        pending: Boolean(t.pending),
        pfcPrimary: t.personal_finance_category?.primary ?? null,
        pfcDetailed: t.personal_finance_category?.detailed ?? null,
        rawPlaid: JSON.stringify(t),
        // New/modified transactions inherit their account's current profile.
        profile: profileByAcctId.get(accountId) ?? "personal",
        updatedAt: nowIso(),
      };
      const found = await db
        .select({
          id: transactions.id,
          categoryId: transactions.categoryId,
          categoryLocked: transactions.categoryLocked,
        })
        .from(transactions)
        .where(eq(transactions.plaidTransactionId, t.transaction_id));
      const existing = found[0];

      // Assign a category unless the user (or agent) locked one in.
      const locked = Boolean(existing?.categoryLocked);
      if (!locked) {
        const resolved = resolveCategory(
          {
            name: row.name,
            merchantName: row.merchantName,
            accountId: row.accountId,
            amountCents: row.amountCents,
            pfcPrimary: row.pfcPrimary,
            pfcDetailed: row.pfcDetailed,
            categoryId: existing?.categoryId ?? null,
            categoryLocked: false,
          },
          ownerRules,
          ownerCategories,
        );
        (row as Record<string, unknown>).categoryId = resolved.categoryId;
        if (resolved.setMerchantName) row.merchantName = resolved.setMerchantName;
      }

      // Link to an active recurring by normalized merchant key, if any matches.
      const merchantKey = normalizeMerchantKey(row.merchantName || row.name);
      const recurringId = merchantKey ? (recurringByMerchantKey.get(merchantKey) ?? null) : null;
      if (recurringId) {
        (row as Record<string, unknown>).recurringId = recurringId;
        const prevDate = recurringUpdates.get(recurringId)?.lastSeenDate;
        if (!prevDate || (row.date && row.date > prevDate)) {
          recurringUpdates.set(recurringId, {
            lastAmountCents: row.amountCents,
            lastSeenDate: row.date ?? prevDate ?? "",
          });
        }
      }

      if (existing) {
        await db
          .update(transactions)
          .set(row)
          .where(eq(transactions.id, existing.id));
      } else {
        await db
          .insert(transactions)
          .values({ id: crypto.randomUUID(), createdAt: nowIso(), ...row });
      }
      changed++;
    }

    for (const r of data.removed) {
      if (!r.transaction_id) continue;
      await db
        .delete(transactions)
        .where(eq(transactions.plaidTransactionId, r.transaction_id));
      changed++;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Flush batched recurring updates (last_amount_cents/last_seen_date) once,
  // after all pages of this sync have been applied.
  for (const [recurringId, update] of recurringUpdates) {
    await db
      .update(recurring)
      .set({
        lastAmountCents: update.lastAmountCents,
        lastSeenDate: update.lastSeenDate || null,
        updatedAt: nowIso(),
      })
      .where(eq(recurring.id, recurringId));
  }

  // Refresh CURRENT/AVAILABLE balances so "Sync now" reflects TRUE current
  // balances, not just yesterday's snapshot from the last accountsGet call —
  // a transaction sync alone does not update balances.
  let balancePath: "balance" | "accounts" | "skipped" = "skipped";
  try {
    const balanceResult = await refreshAccountBalances(db, institutionId);
    balancePath = balanceResult.path;
  } catch (err) {
    // Don't fail the whole sync if balance refresh errors (e.g. transient
    // Plaid outage) — transactions already synced successfully above.
    console.error(`[finance-sync] balance refresh failed for institution ${institutionId}:`, err);
  }
  console.log(`[finance-sync] institution ${institutionId} balance refresh path: ${balancePath}`);

  await db
    .update(institutions)
    .set({ syncCursor: cursor ?? null, lastSyncedAt: nowIso() })
    .where(eq(institutions.id, institutionId));

  return changed;
}

/**
 * Sync every connected institution for an owner.
 *
 * `forceBankRefresh` (default false): poke ALL institutions first (so Plaid
 * re-pulls each bank in parallel), wait once for them to settle, then pull
 * every institution's delta. Batching the pokes + a single settle is much
 * faster than refreshing each institution one-at-a-time.
 */
export async function syncAll(
  db: Db,
  ownerEmail: string,
  opts?: { forceBankRefresh?: boolean },
): Promise<number> {
  const insts = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.ownerEmail, ownerEmail));
  if (opts?.forceBankRefresh) {
    let anyRefreshed = false;
    for (const i of insts) {
      const r = await refreshInstitutionTransactions(db, i.id);
      anyRefreshed = anyRefreshed || r.refreshed;
    }
    if (anyRefreshed) await sleep(REFRESH_SETTLE_MS);
  }
  let total = 0;
  // Per-institution refresh already done above; pull cached delta here.
  for (const i of insts) total += await syncInstitution(db, i.id);
  return total;
}
