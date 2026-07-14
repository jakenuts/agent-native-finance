/**
 * Import a Recurly upcoming-renewals CSV export into the projected-income
 * ledger (fp_projected_entries). Same upload pattern as import-rm-csv:
 * csvText (browser upload, primary) or path (dev/CLI only). Idempotent —
 * keyed by recurly:<subscriptionId>:<renewalDate>, so re-importing the same
 * (or a refreshed) export updates/skips rather than duplicating.
 * ALWAYS dryRun first (the default) to preview counts before writing.
 * Run (CLI/dev):
 *   pnpm action import-recurly-renewals --path "X:/.../renewals.csv" --accountId acc_x --dryRun true
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db/index.js";
import { accounts } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { importRecurlyRenewals, parseRecurlyRenewalsCsv } from "../server/lib/projections.js";

// Renewal exports are small (~100 rows/month); 5MB is generous headroom.
const MAX_CSV_BYTES = 5 * 1024 * 1024;

export default defineAction({
  description:
    "Import a Recurly upcoming-renewals CSV export (header: renewalDateUtc,accountId,subscriptionId,planId,planName,expectedAmount,currency,status,customerId,customerName,customerTier,recurlyAccountUrl,recurlyRecordUrl) into the projected-income ledger. Provide the CSV CONTENTS as `csvText` (the /projections upload dialog path); `path` is dev/CLI only. Rows with expectedAmount <= 0 (free/dev plans) are SKIPPED (counted as skippedFree). Each renewal becomes a 'projected' entry: date = renewal date + payoutLagDays (default 2 — Recurly bills, the payout hits checking later), amountCents = negative cents (income), name = customerName · plan. Idempotent by recurly:<subscriptionId>:<renewalDate> — re-imports update changed rows (date/amount/name) and NEVER downgrade an already-resolved ('received'/'missed'/'canceled') row back to 'projected'. dryRun defaults TRUE and returns counts + date range + total projected dollars — always show the user this before importing for real. Pass accountId (target deposit account, encouraged) so runway attributes the income; the entries' profile stamps from that account (else the active profile).",
  schema: z
    .object({
      csvText: z
        .string()
        .min(1)
        .max(MAX_CSV_BYTES, `CSV is too large (max ${Math.round(MAX_CSV_BYTES / (1024 * 1024))}MB).`)
        .optional()
        .describe("Raw Recurly renewals CSV CONTENTS (the browser-upload path). Primary."),
      fileName: z
        .string()
        .optional()
        .describe("Original file name of the uploaded CSV, for display/echo only."),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute path to the CSV on the SERVER disk. Dev/CLI only."),
      accountId: z
        .string()
        .optional()
        .describe("Target account the payouts hit (business checking). Strongly encouraged."),
      payoutLagDays: z
        .coerce.number()
        .int()
        .min(0)
        .max(30)
        .default(2)
        .describe("Days between the renewal billing date and the payout hitting the bank (default 2)."),
      profile: z
        .enum(["personal", "business"])
        .optional()
        .describe("Profile for the entries. Defaults to the chosen account's profile, else the active profile."),
      dryRun: z
        .boolean()
        .default(true)
        .describe("Preview only (DEFAULT): parse + plan without writing. Pass false to import for real."),
    })
    .refine((v) => Boolean(v.csvText) || Boolean(v.path), {
      message: "Provide either csvText (uploaded file contents) or path (server disk path).",
    }),
  readOnly: false,
  run: async ({ csvText, fileName, path, accountId, payoutLagDays, profile, dryRun }) => {
    let raw: string;
    let sourceLabel: string;

    if (csvText != null) {
      if (fileName && !fileName.toLowerCase().endsWith(".csv")) {
        throw new Error("Uploaded file must be a .csv file.");
      }
      if (csvText.trim().length === 0) {
        throw new Error("The uploaded file is empty.");
      }
      raw = csvText;
      sourceLabel = fileName ?? "uploaded.csv";
    } else if (path != null) {
      if (!path.toLowerCase().endsWith(".csv")) {
        throw new Error("path must point to a .csv file.");
      }
      let fileStat;
      try {
        fileStat = await stat(path);
      } catch {
        throw new Error(`File not found: ${path}`);
      }
      if (!fileStat.isFile()) {
        throw new Error(`Not a file: ${path}`);
      }
      raw = await readFile(path, "utf8");
      sourceLabel = path;
    } else {
      throw new Error("Provide either csvText (uploaded file contents) or path (server disk path).");
    }

    const db = getDb();
    const owner = ownerEmail();

    let accountProfile: "personal" | "business" | null = null;
    if (accountId) {
      const acct = await db
        .select({ id: accounts.id, profile: accounts.profile })
        .from(accounts)
        .where(and(eq(accounts.ownerEmail, owner), eq(accounts.id, accountId)));
      if (acct.length === 0) throw new Error(`Account ${accountId} not found.`);
      accountProfile = acct[0].profile === "business" ? "business" : "personal";
    }
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile =
      profile ?? accountProfile ?? (effectiveProfile === "all" ? "personal" : effectiveProfile);

    const startedAt = Date.now();
    const parsed = parseRecurlyRenewalsCsv(raw);
    const result = await importRecurlyRenewals(db, owner, {
      rows: parsed.rows,
      accountId: accountId ?? null,
      profile: targetProfile,
      payoutLagDays,
      dryRun,
    });

    return {
      ok: true,
      dryRun,
      parsed: result.parsed,
      skippedFree: parsed.skippedFree,
      skippedInvalid: parsed.skippedInvalid,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      totalProjectedCents: result.totalProjectedCents,
      totalProjected: result.totalProjectedCents / 100,
      payoutLagDays,
      accountId: accountId ?? null,
      profile: targetProfile,
      source: sourceLabel,
      elapsedMs: Date.now() - startedAt,
    };
  },
});
