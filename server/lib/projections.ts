/**
 * Projected-income ledger core: parse a Recurly upcoming-renewals CSV export,
 * idempotently upsert entries into fp_projected_entries, and select the
 * window of trustworthy 'projected' rows that runway math should count.
 * Framework-light (takes a db instance / plain rows) so actions, get-runway,
 * and tests can all call it directly.
 *
 * Semantics: these are ESTIMATES, not promises — cards fail, customers churn.
 * `date` is the expected BANK date (Recurly bills on renewalDateUtc; the
 * Stripe payout hits checking ~payoutLagDays later). Money is signed INTEGER
 * cents, Plaid convention: income NEGATIVE (a $96 renewal is -9600).
 *
 * Recurly CSV header (generic export shape):
 *   renewalDateUtc,accountId,subscriptionId,planId,planName,expectedAmount,
 *   currency,status,customerId,customerName,customerTier,
 *   recurlyAccountUrl,recurlyRecordUrl
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { projectedEntries } from "../db/schema.js";
import { parseCsv } from "./rm-import.js";
import type { Profile } from "./profile.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

export const RECURLY_CSV_HEADER = [
  "renewalDateUtc",
  "accountId",
  "subscriptionId",
  "planId",
  "planName",
  "expectedAmount",
  "currency",
  "status",
  "customerId",
  "customerName",
  "customerTier",
  "recurlyAccountUrl",
  "recurlyRecordUrl",
] as const;

/** Days a 'projected' row may sit past-dated before runway stops counting it. */
export const STALE_PROJECTION_DAYS = 7;

export type ProjectedEntryStatus = "projected" | "received" | "missed" | "canceled";
export type ProjectedEntrySource = "manual" | "recurly-import" | "api";

export interface ParsedRenewalRow {
  /** Renewal (billing) date, UTC date-only YYYY-MM-DD. */
  renewalDate: string;
  subscriptionId: string;
  /** Signed cents, income NEGATIVE (already flipped from expectedAmount). */
  amountCents: number;
  /** Display name: "<customerName> · <short plan label>". */
  name: string;
  /** Idempotency key: recurly:<subscriptionId>:<renewalDate>. */
  externalKey: string;
  /** JSON-able extras preserved for drill-down. */
  metadata: {
    planId: string;
    planName: string;
    customerId: string;
    customerName: string;
    customerTier: string;
    currency: string;
    recurlyAccountUrl: string;
    recurlyRecordUrl: string;
    renewalDateUtc: string;
  };
}

export interface ParseRecurlyResult {
  rows: ParsedRenewalRow[];
  /** Rows skipped because expectedAmount <= 0 (free/dev plans). */
  skippedFree: number;
  /** Rows skipped for an unparseable date or amount. */
  skippedInvalid: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

/** Shorten "Elite Monthly Plan" style plan names to a compact label. */
function shortPlanLabel(planName: string, planId: string): string {
  const name = planName.trim() || planId.trim();
  return name.replace(/\s+plan$/i, "").trim() || "Renewal";
}

/**
 * Parse a Recurly upcoming-renewals CSV export (quoted-field-safe, reuses the
 * shared CSV parser). Skips expectedAmount <= 0 rows (free/dev plans) and
 * counts them as skippedFree. Amounts flip sign: expectedAmount is dollars of
 * INCOME, stored as NEGATIVE cents per the Plaid convention.
 */
export function parseRecurlyRenewalsCsv(raw: string): ParseRecurlyResult {
  const table = parseCsv(raw);
  if (table.length === 0) return { rows: [], skippedFree: 0, skippedInvalid: 0 };

  const header = table[0].map((h) => h.trim());
  const missing = RECURLY_CSV_HEADER.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    throw new Error(
      `Unrecognized Recurly renewals CSV — missing column(s): ${missing.join(", ")}`,
    );
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const cell = (cells: string[], key: string): string => (cells[idx[key]] ?? "").trim();

  const rows: ParsedRenewalRow[] = [];
  let skippedFree = 0;
  let skippedInvalid = 0;

  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    if (cells.length === 1 && cells[0].trim() === "") continue;

    const amountRaw = Number(cell(cells, "expectedAmount").replace(/[,$]/g, ""));
    if (!Number.isFinite(amountRaw)) {
      skippedInvalid++;
      continue;
    }
    if (amountRaw <= 0) {
      skippedFree++;
      continue;
    }

    // renewalDateUtc is an ISO UTC timestamp (e.g. 2026-07-15T08:00:00Z) or a
    // bare date; normalize to the UTC date-only part.
    const rawDate = cell(cells, "renewalDateUtc");
    const parsedMs = Date.parse(
      /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T00:00:00Z` : rawDate,
    );
    if (!Number.isFinite(parsedMs)) {
      skippedInvalid++;
      continue;
    }
    const renewalDate = new Date(parsedMs).toISOString().slice(0, 10);

    const subscriptionId = cell(cells, "subscriptionId");
    if (!subscriptionId) {
      skippedInvalid++;
      continue;
    }

    const customerName = cell(cells, "customerName");
    const planName = cell(cells, "planName");
    const planId = cell(cells, "planId");
    const label = shortPlanLabel(planName, planId);
    const name = customerName ? `${customerName} · ${label}` : label;

    rows.push({
      renewalDate,
      subscriptionId,
      amountCents: -Math.round(amountRaw * 100), // income = NEGATIVE cents
      name,
      externalKey: `recurly:${subscriptionId}:${renewalDate}`,
      metadata: {
        planId,
        planName,
        customerId: cell(cells, "customerId"),
        customerName,
        customerTier: cell(cells, "customerTier"),
        currency: cell(cells, "currency") || "USD",
        recurlyAccountUrl: cell(cells, "recurlyAccountUrl"),
        recurlyRecordUrl: cell(cells, "recurlyRecordUrl"),
        renewalDateUtc: rawDate,
      },
    });
  }

  return { rows, skippedFree, skippedInvalid };
}

export interface ImportRecurlyResult {
  parsed: number;
  skippedFree: number;
  skippedInvalid: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Inclusive expected-BANK-date range of the parsed rows (null when empty). */
  dateFrom: string | null;
  dateTo: string | null;
  /** Total projected income across parsed rows, POSITIVE dollars-cents for display. */
  totalProjectedCents: number;
}

/**
 * Idempotent upsert of parsed Recurly renewal rows keyed by
 * (owner_email, external_key). Existing rows get date/amount/name/metadata
 * refreshed when they changed — but a row already resolved as 'received' /
 * 'missed' / 'canceled' is NEVER downgraded back to 'projected' (and its
 * date/amount are left alone; the resolution reflects what actually
 * happened). Returns per-disposition counts.
 */
export async function importRecurlyRenewals(
  db: Db,
  owner: string,
  opts: {
    rows: ParsedRenewalRow[];
    accountId: string | null;
    profile: Profile;
    payoutLagDays: number;
    dryRun?: boolean;
  },
): Promise<ImportRecurlyResult> {
  const { rows, accountId, profile, payoutLagDays, dryRun } = opts;
  const nowIso = new Date().toISOString();

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  let totalProjectedCents = 0;

  // Preload every existing row for the keys in this batch (one query).
  const keys = rows.map((r) => r.externalKey);
  const existingRows = keys.length
    ? await db
        .select()
        .from(projectedEntries)
        .where(
          and(eq(projectedEntries.ownerEmail, owner), inArray(projectedEntries.externalKey, keys)),
        )
    : [];
  const existingByKey = new Map(existingRows.map((e) => [e.externalKey, e]));

  for (const row of rows) {
    const bankDate = addDays(row.renewalDate, payoutLagDays);
    if (dateFrom === null || bankDate < dateFrom) dateFrom = bankDate;
    if (dateTo === null || bankDate > dateTo) dateTo = bankDate;
    totalProjectedCents += Math.abs(row.amountCents);

    const existing = existingByKey.get(row.externalKey);
    if (!existing) {
      created++;
      if (!dryRun) {
        await db.insert(projectedEntries).values({
          id: `proj_${crypto.randomUUID().slice(0, 12)}`,
          ownerEmail: owner,
          profile,
          accountId,
          date: bankDate,
          amountCents: row.amountCents,
          name: row.name,
          source: "recurly-import",
          externalKey: row.externalKey,
          status: "projected",
          notes: null,
          metadata: JSON.stringify(row.metadata),
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
      continue;
    }

    // Never touch a resolved row — the user already reconciled it.
    if (existing.status !== "projected") {
      unchanged++;
      continue;
    }

    const changed =
      existing.date !== bankDate ||
      existing.amountCents !== row.amountCents ||
      existing.name !== row.name ||
      (accountId != null && existing.accountId !== accountId);
    if (!changed) {
      unchanged++;
      continue;
    }

    updated++;
    if (!dryRun) {
      await db
        .update(projectedEntries)
        .set({
          date: bankDate,
          amountCents: row.amountCents,
          name: row.name,
          ...(accountId != null ? { accountId } : {}),
          metadata: JSON.stringify(row.metadata),
          updatedAt: nowIso,
        })
        .where(
          and(eq(projectedEntries.ownerEmail, owner), eq(projectedEntries.id, existing.id)),
        );
    }
  }

  return {
    parsed: rows.length,
    skippedFree: 0, // caller merges the parse-stage counts
    skippedInvalid: 0,
    created,
    updated,
    unchanged,
    dateFrom,
    dateTo,
    totalProjectedCents,
  };
}

export interface ProjectedEntryForRunway {
  id: string;
  name: string;
  /** Expected bank date, YYYY-MM-DD. */
  date: string;
  /** Signed cents (income negative). */
  amountCents: number;
  accountId: string | null;
}

/**
 * The 'projected' entries runway math should count in [from, to]:
 * status='projected' only, and past-dated rows older than STALE_PROJECTION_DAYS
 * are EXCLUDED automatically (a renewal that hasn't landed a week later is a
 * stale estimate — it stays on /projections as past due for manual
 * resolution, but stops propping up the balance projection).
 */
export async function projectedEntriesForWindow(
  db: Db,
  owner: string,
  profile: Profile | "all",
  opts: { from: string; to: string; accountId?: string; today?: string },
): Promise<ProjectedEntryForRunway[]> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const staleCutoff = addDays(today, -STALE_PROJECTION_DAYS);
  const effectiveFrom = opts.from > staleCutoff ? opts.from : staleCutoff;

  const conditions = [
    eq(projectedEntries.ownerEmail, owner),
    eq(projectedEntries.status, "projected"),
    gte(projectedEntries.date, effectiveFrom),
    lte(projectedEntries.date, opts.to),
  ];
  if (profile !== "all") conditions.push(eq(projectedEntries.profile, profile));
  if (opts.accountId) conditions.push(eq(projectedEntries.accountId, opts.accountId));

  const rows = await db
    .select({
      id: projectedEntries.id,
      name: projectedEntries.name,
      date: projectedEntries.date,
      amountCents: projectedEntries.amountCents,
      accountId: projectedEntries.accountId,
    })
    .from(projectedEntries)
    .where(and(...conditions));

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
