/**
 * Background Recurly projection refresh — DETERMINISTIC (no agent).
 *
 * The projected-income ledger (fp_projected_entries) was previously kept fresh
 * only by the agent-driven `daily-digest` job calling `sync-recurly-renewals`.
 * That job runs an LLM, and in the deployed background context the agent has no
 * session and its API key resolves empty / over-quota, so every run errored and
 * projections silently froze (stale renewals, growing past-due list). This
 * plugin removes that dependency: it calls the SAME deterministic library the
 * `sync-recurly-renewals` action uses (projection-source fetch +
 * `importRecurlyRenewals`) directly on a timer. No LLM, no agent job.
 *
 * Runs ~2min after startup (letting the DB settle) and then every 24h. The
 * import is idempotent (shared recurly:<uuid>:<renewalDate> keys) and never
 * downgrades a resolved (received/missed/canceled) row, so re-running is safe.
 *
 * Account attribution self-heals: it reuses whichever account the existing
 * recurly-import entries are already attributed to (the business checking the
 * user/agent last pointed them at), so runway keeps crediting the right
 * account without any hardcoded id.
 *
 * Env:
 *   FINANCE_DISABLE_SCHEDULER=true          — disables this too (shared kill-switch)
 *   FINANCE_DISABLE_PROJECTIONS_REFRESH=true — disables only this refresh
 * Skips silently when the Recurly API source is not configured.
 */
import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server";
import { getDb } from "../db/index.js";
import { projectedEntries } from "../db/schema.js";
import { ownerEmail } from "../lib/owner.js";
import {
  fetchProjectionSourceRenewals,
  isProjectionSourceConfigured,
} from "../lib/projection-sources.js";
import { importRecurlyRenewals } from "../lib/projections.js";

const INITIAL_DELAY_MS = 120_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 35;
const PAYOUT_LAG_DAYS = 2;
/**
 * How many days past its expected date a Recurly *projection* may linger before
 * it's auto-dropped. Actual renewal outcomes for the recent window are shown
 * via the `recurly-recent-activity` action instead of reconciling each
 * projection, so past-due projections have no lasting value — drop them rather
 * than letting them accumulate. Override via FINANCE_PROJECTION_DROP_PAST_DAYS.
 */
const DROP_PAST_DAYS = Number(process.env.FINANCE_PROJECTION_DROP_PAST_DAYS ?? 3);

async function refreshProjections(reason: string) {
  if (!(await isProjectionSourceConfigured("recurly-api"))) {
    console.log("[projections-scheduler] Recurly API source not configured — skipping");
    return;
  }
  const db = getDb();
  const owner = ownerEmail();

  // Reuse the account the current recurly projections are attributed to, so
  // runway keeps crediting the right business checking without a hardcoded id.
  const [last] = await db
    .select({ accountId: projectedEntries.accountId })
    .from(projectedEntries)
    .where(
      and(
        eq(projectedEntries.ownerEmail, owner),
        eq(projectedEntries.source, "recurly-import"),
        isNotNull(projectedEntries.accountId),
      ),
    )
    .orderBy(desc(projectedEntries.updatedAt))
    .limit(1);
  const accountId = last?.accountId ?? null;

  const fetched = await fetchProjectionSourceRenewals("recurly-api", WINDOW_DAYS);
  const result = await importRecurlyRenewals(db, owner, {
    rows: fetched.rows,
    accountId,
    // Recurly renewals are business income; entries stamp business.
    profile: "business",
    payoutLagDays: PAYOUT_LAG_DAYS,
    dryRun: false,
  });

  // Auto-drop past-due Recurly projections (recent outcomes are reported by
  // recurly-recent-activity instead of reconciling each one). Only touches
  // unresolved recurly-import rows — manual entries and resolved rows are left
  // alone. `date` is text YYYY-MM-DD, so a lexicographic `<` on an ISO cutoff
  // is a correct date comparison.
  let dropped = 0;
  if (DROP_PAST_DAYS >= 0) {
    const cutoff = new Date(Date.now() - DROP_PAST_DAYS * 86_400_000).toISOString().slice(0, 10);
    const removed = await db
      .delete(projectedEntries)
      .where(
        and(
          eq(projectedEntries.ownerEmail, owner),
          eq(projectedEntries.source, "recurly-import"),
          eq(projectedEntries.status, "projected"),
          lt(projectedEntries.date, cutoff),
        ),
      )
      .returning({ id: projectedEntries.id });
    dropped = removed.length;
  }

  console.log(
    `[projections-scheduler] ${reason}: ${fetched.activeSubscriptions} active subs, ` +
      `${fetched.rows.length} renewals in window → created ${result.created}, ` +
      `updated ${result.updated}, unchanged ${result.unchanged}, dropped ${dropped} stale ` +
      `(${result.dateFrom}..${result.dateTo}, acct ${accountId ?? "none"})`,
  );
}

async function run(reason: string) {
  try {
    await runWithRequestContext({ userEmail: ownerEmail() }, () => refreshProjections(reason));
  } catch (err) {
    console.error(`[projections-scheduler] ${reason} failed`, err);
  }
}

export default () => {
  if (
    process.env.FINANCE_DISABLE_SCHEDULER === "true" ||
    process.env.FINANCE_DISABLE_PROJECTIONS_REFRESH === "true"
  ) {
    console.log("[projections-scheduler] disabled via env");
    return;
  }
  void runWithRequestContext({ userEmail: ownerEmail() }, async () => {
    if (!(await isProjectionSourceConfigured("recurly-api"))) {
      console.log("[projections-scheduler] Recurly API source not configured — not scheduling");
      return;
    }

    setTimeout(() => {
      void run("startup refresh");
    }, INITIAL_DELAY_MS);

    setInterval(() => {
      void run("daily refresh");
    }, INTERVAL_MS);
  });
};
