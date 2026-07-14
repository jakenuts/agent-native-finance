/**
 * Background Plaid sync: runs once ~90s after startup (letting the server
 * settle) and then every 6 hours, in addition to the webhook-triggered and
 * manual (UI/agent) syncs. Keeps balances/transactions fresh even if no
 * webhook fires and nobody clicks "Sync now".
 *
 * Each cycle FORCES a bank re-pull (`/transactions/refresh`) before syncing so
 * institutions that Plaid only refreshes ~once a day (e.g. Example Bank)
 * stay current instead of lagging the bank by up to a day. Set
 * FINANCE_DISABLE_TXN_REFRESH=true to fall back to cheap cached-delta syncs
 * (avoids per-refresh Plaid charges) and rely on webhooks + manual "Sync now".
 *
 * Set FINANCE_DISABLE_SCHEDULER=true to skip entirely (e.g. in tests or
 * when running multiple instances that shouldn't all poll Plaid).
 */
import { runWithRequestContext } from "@agent-native/core/server";
import { getDb } from "../db/index.js";
import { syncAll } from "../lib/finance-sync.js";
import { ownerEmail } from "../lib/owner.js";

const INITIAL_DELAY_MS = 90_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FORCE_BANK_REFRESH = process.env.FINANCE_DISABLE_TXN_REFRESH !== "true";

async function runSync(reason: string) {
  try {
    const owner = ownerEmail();
    const changed = await runWithRequestContext({ userEmail: owner }, () =>
      syncAll(getDb(), owner, { forceBankRefresh: FORCE_BANK_REFRESH }),
    );
    console.log(`[sync-scheduler] ${reason}: ${changed} transactions changed`);
  } catch (err) {
    console.error(`[sync-scheduler] ${reason} failed`, err);
  }
}

export default () => {
  if (process.env.FINANCE_DISABLE_SCHEDULER === "true") {
    console.log("[sync-scheduler] disabled via FINANCE_DISABLE_SCHEDULER");
    return;
  }

  setTimeout(() => {
    void runSync("startup sync");
  }, INITIAL_DELAY_MS);

  setInterval(() => {
    void runSync("scheduled sync");
  }, INTERVAL_MS);
};
