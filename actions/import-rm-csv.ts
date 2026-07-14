/**
 * Import a Rocket Money CSV export (transaction history) into Finance.
 * Accepts EITHER uploaded CSV text (the deployed-site path — the browser
 * reads the file with FileReader and sends its contents) OR a local disk
 * path (dev/CLI convenience only — the path is read on the SERVER, so it
 * only exists in local development, never on the deployed container).
 * ALWAYS dryRun first to preview counts before writing.
 * Run (CLI/dev, path mode):
 *   pnpm action import-rm-csv --path "X:/.../Personal-Rocket-Export.csv" --profile personal --dryRun true
 *   pnpm action import-rm-csv --path "X:/.../Personal-Rocket-Export.csv" --profile personal
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { getDb } from "../server/db/index.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";
import { parseRmCsv, runRmImport } from "../server/lib/rm-import.js";

// Guard the inlined payload: the real Personal export is ~27K rows and a few
// MB; 15MB is comfortable headroom while still rejecting an accidental huge
// upload before it hits the parser.
const MAX_CSV_BYTES = 15 * 1024 * 1024;

export default defineAction({
  description:
    "Import a Rocket Money CSV transaction-history export into Finance. Provide the CSV CONTENT as `csvText` (this is what the deployed /import file picker sends — the browser reads the chosen .csv and uploads its text); `path` reads a file from the SERVER disk and is dev/CLI only (the path won't exist on the deployed container). Exactly one of csvText/path is required. ALWAYS call with dryRun:true first and report the summary (rows parsed, accounts/categories to create, duplicates, importable count) before running for real — never import blind. Matches accounts by (Institution Name, Account Name, last-4), finds-or-creates MANUAL accounts, dedupes rows that overlap an existing Plaid-linked account (same institution+mask, same date+amount) so already-synced history isn't duplicated, and is idempotent — re-importing the same file skips rows already imported. Amounts use Finance's sign convention directly (positive = outflow), confirmed against real exports — no sign flip is applied.",
  schema: z
    .object({
      csvText: z
        .string()
        .min(1)
        .max(MAX_CSV_BYTES, `CSV is too large (max ${Math.round(MAX_CSV_BYTES / (1024 * 1024))}MB).`)
        .optional()
        .describe(
          "Raw Rocket Money CSV file CONTENTS (the deployed upload path). Provide this when uploading from the browser.",
        ),
      fileName: z
        .string()
        .optional()
        .describe("Original file name of the uploaded CSV, for display/echo only."),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute path to the CSV export on the SERVER disk. Dev/CLI only — not available on the deployed site."),
      profile: z
        .enum(["personal", "business"])
        .optional()
        .describe("Profile to import into. Defaults to the active profile."),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Preview only: parse + plan without writing. Always try this first."),
    })
    .refine((v) => Boolean(v.csvText) || Boolean(v.path), {
      message: "Provide either csvText (uploaded file contents) or path (server disk path).",
    }),
  readOnly: false,
  run: async ({ csvText, fileName, path, profile, dryRun }) => {
    let raw: string;
    let sourceLabel: string;

    if (csvText != null) {
      // Upload path (primary): the browser already read the file.
      if (fileName && !fileName.toLowerCase().endsWith(".csv")) {
        throw new Error("Uploaded file must be a .csv file.");
      }
      if (csvText.trim().length === 0) {
        throw new Error("The uploaded file is empty.");
      }
      raw = csvText;
      sourceLabel = fileName ?? "uploaded.csv";
    } else if (path != null) {
      // Server-disk path (dev/CLI only).
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
      // Unreachable given the schema refine, but keep a clear message.
      throw new Error("Provide either csvText (uploaded file contents) or path (server disk path).");
    }

    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const targetProfile = effectiveProfile === "all" ? "personal" : effectiveProfile;

    const rows = parseRmCsv(raw);

    const result = await runRmImport(db, owner, targetProfile, rows, dryRun);

    return { ...result, profile: targetProfile, source: sourceLabel };
  },
});
