/**
 * Minimal Recurly v3 API client for upcoming-renewal projections.
 *
 * Fetches ACTIVE subscriptions and maps the ones whose current period ends
 * within a forward window onto the same `ParsedRenewalRow` shape the CSV
 * import uses — so API sync and CSV import share one idempotent path
 * (`external_key = recurly:<uuid>:<renewalDate>`; the CSV's subscriptionId is
 * the Recurly uuid, so we key off `uuid` here for cross-source stability).
 *
 * Auth: RECURLY_API_KEY (HTTP Basic, key as username). RECURLY_SUBDOMAIN is
 * only used to build admin-console links in metadata.
 */
import type { ParsedRenewalRow } from "./projections.js";
import { resolveConfigValue } from "./config-secrets.js";

const RECURLY_API_BASE = "https://v3.recurly.com";
const RECURLY_API_VERSION = "application/vnd.recurly.v2021-02-25";

interface RecurlyAccountMini {
  id?: string;
  code?: string;
  company?: string | null;
  email?: string | null;
}

interface RecurlyPlanMini {
  id?: string;
  code?: string;
  name?: string;
}

interface RecurlySubscription {
  id: string;
  uuid?: string;
  state: string;
  account?: RecurlyAccountMini;
  plan?: RecurlyPlanMini;
  unit_amount?: number;
  quantity?: number;
  subtotal?: number;
  currency?: string;
  current_period_ends_at?: string | null;
}

interface RecurlyList<T> {
  object: string;
  has_more: boolean;
  next: string | null;
  data: T[];
  error?: { type?: string; message?: string };
}

/** A Recurly transaction (money-in attempt) — used for recent renewal outcomes. */
interface RecurlyTransaction {
  id: string;
  type?: string; // authorization | capture | purchase | refund | verify
  origin?: string; // purchase | renewal | immediate_change | ...
  status?: string; // success | declined | error | void | ...
  amount?: number;
  currency?: string;
  created_at?: string;
  collected_at?: string | null;
  account?: RecurlyAccountMini;
}

export interface FetchRenewalsResult {
  rows: ParsedRenewalRow[];
  /** Active subs whose renewal falls in-window but bill $0 (free plans). */
  skippedFree: number;
  /** Total active subscriptions inspected across all pages. */
  activeSubscriptions: number;
  windowFrom: string;
  windowTo: string;
}

async function requireConfigValue(name: string): Promise<string> {
  const value = await resolveConfigValue(name);
  if (!value) {
    throw new Error(
      `${name} is not configured. Set it through setup, scoped secrets, or deployment environment variables to enable Recurly API sync.`,
    );
  }
  return value;
}

function shortPlanLabel(plan: RecurlyPlanMini | undefined): string {
  const name = plan?.name?.trim();
  if (name) {
    // CSV path shortens verbose marketing names; mirror the spirit: keep it tight.
    if (name.length <= 40) return name;
    return `${name.slice(0, 37)}...`;
  }
  return plan?.code ?? "Subscription";
}

async function fetchPage<T>(apiKey: string, path: string): Promise<RecurlyList<T>> {
  const res = await fetch(`${RECURLY_API_BASE}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      Accept: RECURLY_API_VERSION,
      // Recurly 406s on fetch's default wildcard Accept-Language.
      "Accept-Language": "en-US",
    },
  });
  const body = (await res.json()) as RecurlyList<T>;
  if (!res.ok) {
    throw new Error(
      `Recurly API ${res.status}: ${body?.error?.message ?? "request failed"}`,
    );
  }
  return body;
}

function accountLabel(account: RecurlyAccountMini | undefined): string {
  return (
    account?.company?.trim() ||
    account?.code?.trim() ||
    account?.email?.trim() ||
    "Account"
  );
}

/**
 * Fetch active subscriptions renewing within the next `days` days and map to
 * ParsedRenewalRow. Paginates defensively (a few hundred subs = 1-2 pages).
 */
export async function fetchUpcomingRenewals(days: number): Promise<FetchRenewalsResult> {
  const apiKey = await requireConfigValue("RECURLY_API_KEY");
  const subdomain = (await resolveConfigValue("RECURLY_SUBDOMAIN")) || "app";

  const now = new Date();
  const to = new Date(now.getTime() + days * 86_400_000);
  const windowFrom = now.toISOString();
  const windowTo = to.toISOString();

  const rows: ParsedRenewalRow[] = [];
  let skippedFree = 0;
  let activeSubscriptions = 0;

  let path: string | null = `/subscriptions?state=active&limit=200`;
  let guard = 0;
  while (path && guard < 25) {
    guard++;
    const page: RecurlyList<RecurlySubscription> = await fetchPage(apiKey, path);
    for (const sub of page.data ?? []) {
      activeSubscriptions++;
      const endsAt = sub.current_period_ends_at;
      if (!endsAt) continue;
      if (endsAt < windowFrom || endsAt > windowTo) continue;

      const amount =
        typeof sub.subtotal === "number"
          ? sub.subtotal
          : (sub.unit_amount ?? 0) * (sub.quantity ?? 1);
      if (!(amount > 0)) {
        skippedFree++;
        continue;
      }

      const uuid = sub.uuid ?? sub.id;
      const renewalDate = endsAt.slice(0, 10);
      const customer =
        sub.account?.company?.trim() ||
        sub.account?.code?.trim() ||
        sub.account?.email?.trim() ||
        "Account";

      rows.push({
        renewalDate,
        subscriptionId: uuid,
        // Income is NEGATIVE cents per the app-wide sign convention.
        amountCents: -Math.round(amount * 100),
        name: `${customer} · ${shortPlanLabel(sub.plan)}`,
        externalKey: `recurly:${uuid}:${renewalDate}`,
        metadata: {
          planId: sub.plan?.code ?? "",
          planName: sub.plan?.name ?? "",
          customerId: sub.account?.code ?? sub.account?.id ?? "",
          customerName: customer,
          customerTier: "",
          currency: sub.currency ?? "USD",
          recurlyAccountUrl: sub.account?.id
            ? `https://${subdomain}.recurly.com/accounts/${sub.account.code ?? sub.account.id}`
            : "",
          recurlyRecordUrl: `https://${subdomain}.recurly.com/subscriptions/${uuid}`,
          renewalDateUtc: endsAt,
        },
      });
    }
    path = page.has_more && page.next ? page.next : null;
  }

  rows.sort((a, b) => a.renewalDate.localeCompare(b.renewalDate));
  return { rows, skippedFree, activeSubscriptions, windowFrom, windowTo };
}

export interface RenewalOutcome {
  id: string;
  status: string;
  /** Gross charge amount in POSITIVE cents (a summary figure, not a signed ledger entry). */
  amountCents: number;
  currency: string;
  createdAt: string;
  account: string;
  origin: string;
}

export interface RecentRenewalActivityResult {
  windowDays: number;
  from: string;
  succeeded: { count: number; totalCents: number; rows: RenewalOutcome[] };
  failed: { count: number; totalCents: number; rows: RenewalOutcome[] };
}

/**
 * Fetch ACTUAL subscription-charge outcomes over the trailing `days` window
 * from Recurly's transactions API, split into succeeded vs failed with totals.
 * This replaces per-projection reconciliation: rather than tracking whether
 * each projected renewal landed, we just report what Recurly actually did in
 * the recent window. Amounts are POSITIVE cents (summary, not a signed ledger
 * entry). Requires RECURLY_API_KEY.
 */
export async function fetchRecentRenewalActivity(days: number): Promise<RecentRenewalActivityResult> {
  const apiKey = await requireConfigValue("RECURLY_API_KEY");
  const beginTime = new Date(Date.now() - days * 86_400_000).toISOString();

  const succeeded = { count: 0, totalCents: 0, rows: [] as RenewalOutcome[] };
  const failed = { count: 0, totalCents: 0, rows: [] as RenewalOutcome[] };

  // type=purchase → money-in charges (renewals dominate for a subscription
  // business); split by status. void/refund/other statuses are ignored.
  let path: string | null =
    `/transactions?type=purchase&begin_time=${encodeURIComponent(beginTime)}&order=desc&limit=200`;
  let guard = 0;
  while (path && guard < 25) {
    guard++;
    const page: RecurlyList<RecurlyTransaction> = await fetchPage(apiKey, path);
    for (const t of page.data ?? []) {
      const cents = Math.round((t.amount ?? 0) * 100);
      const outcome: RenewalOutcome = {
        id: t.id,
        status: t.status ?? "unknown",
        amountCents: cents,
        currency: t.currency ?? "USD",
        createdAt: t.created_at ?? "",
        account: accountLabel(t.account),
        origin: t.origin ?? "",
      };
      if (t.status === "success") {
        succeeded.count++;
        succeeded.totalCents += cents;
        succeeded.rows.push(outcome);
      } else if (t.status === "declined" || t.status === "error") {
        failed.count++;
        failed.totalCents += cents;
        failed.rows.push(outcome);
      }
    }
    path = page.has_more && page.next ? page.next : null;
  }

  return { windowDays: days, from: beginTime, succeeded, failed };
}
