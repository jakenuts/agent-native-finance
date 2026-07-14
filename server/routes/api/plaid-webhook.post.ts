/**
 * Plaid webhook receiver. Plaid POSTs here on TRANSACTIONS updates (any code,
 * e.g. SYNC_UPDATES_AVAILABLE, INITIAL_UPDATE, HISTORICAL_UPDATE, DEFAULT_UPDATE)
 * so we can pull new data without waiting for the scheduled sync.
 *
 * Always responds 200 quickly — Plaid retries aggressively on non-2xx, and we
 * don't want a slow/failed sync to look like a delivery failure. The actual
 * sync runs fire-and-forget after the response is sent.
 *
 * This is intentionally a raw route, not an action: it's an external
 * webhook callback with a Plaid-defined payload shape, not an app operation
 * the UI or agent calls directly.
 */
import { runWithRequestContext } from "@agent-native/core/server";
import { defineEventHandler, readBody } from "h3";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { institutions } from "../../db/schema.js";
import { syncInstitution } from "../../lib/finance-sync.js";

export default defineEventHandler(async (event) => {
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    return { received: true };
  }

  const webhookType = typeof body.webhook_type === "string" ? body.webhook_type : "unknown";
  const webhookCode = typeof body.webhook_code === "string" ? body.webhook_code : "unknown";
  const itemId = typeof body.item_id === "string" ? body.item_id : null;

  console.log(`[plaid-webhook] ${webhookType} / ${webhookCode} (item_id=${itemId ?? "?"})`);

  const shouldSync =
    webhookType === "TRANSACTIONS" || webhookCode === "SYNC_UPDATES_AVAILABLE";

  if (shouldSync && itemId) {
    // Fire-and-forget: don't block the webhook response on the sync.
    void (async () => {
      try {
        const db = getDb();
        const rows = await db
          .select({ id: institutions.id, ownerEmail: institutions.ownerEmail })
          .from(institutions)
          .where(eq(institutions.plaidItemId, itemId));
        if (rows.length === 0) {
          console.warn(`[plaid-webhook] no institution found for item_id=${itemId}`);
          return;
        }
        const changed = await runWithRequestContext({ userEmail: rows[0].ownerEmail }, () =>
          syncInstitution(db, rows[0].id),
        );
        console.log(`[plaid-webhook] synced institution ${rows[0].id}: ${changed} changed`);
      } catch (err) {
        console.error("[plaid-webhook] sync failed", err);
      }
    })();
  }

  return { received: true };
});
