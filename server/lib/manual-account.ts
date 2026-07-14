/**
 * Manual (non-Plaid) account + institution helpers. Finance can represent an
 * account Plaid cannot link — a closed-but-in-repayment card, an external loan,
 * a cash stash — as a MANUAL account the user edits by hand. These live under a
 * synthetic "manual" institution created with the SAME convention the Rocket
 * Money CSV importer uses (see server/lib/rm-import.ts), so that
 * refreshAccountBalances / syncInstitution / get-merge-suggestions all treat
 * them as non-Plaid and skip them:
 *   - fp_institutions.status      = 'manual'
 *   - fp_institutions.plaid_item_id = 'manual:' + slug(name)
 *   - fp_institutions.access_token  = 'manual_import' (placeholder, never a real token)
 * Framework-light (takes a db instance) so it's usable from actions and tests.
 */
import { and, eq } from "drizzle-orm";
import { institutions } from "../db/schema.js";
import type { Profile } from "./profile.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

/** Placeholder access token shared by every manual institution (matches rm-import). */
export const MANUAL_ACCESS_TOKEN = "manual_import";

/** Lowercase, hyphenated slug for a manual institution's plaid_item_id key. */
export function slugifyInstitutionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True for a manual/imported (non-Plaid) institution — sync/balance no-ops. */
export function isManualInstitution(inst: {
  status?: string | null;
  accessToken?: string | null;
}): boolean {
  return inst.status === "manual" || inst.accessToken === MANUAL_ACCESS_TOKEN;
}

export interface ManualInstitutionResult {
  institutionId: string;
  created: boolean;
  /** True when a REAL (Plaid-linked) institution with this name also exists —
   * the caller still gets a SEPARATE manual institution, but can surface a
   * "you may want to merge" note. */
  realPlaidNameCollision: boolean;
}

/**
 * Find-or-create a MANUAL institution by name for this owner. Reuses an
 * existing manual institution with the same slug key if present. If a REAL
 * Plaid institution shares the name, still creates/uses a separate manual one
 * but flags `realPlaidNameCollision` so callers can suggest a merge.
 */
export async function findOrCreateManualInstitution(
  db: Db,
  owner: string,
  institutionName: string,
  profile: Profile,
): Promise<ManualInstitutionResult> {
  const slug = slugifyInstitutionName(institutionName);
  const key = `manual:${slug}`;

  // A real Plaid institution with the same (case-insensitive) display name?
  const sameName = await db
    .select({
      id: institutions.id,
      name: institutions.name,
      status: institutions.status,
      accessToken: institutions.accessToken,
      plaidItemId: institutions.plaidItemId,
    })
    .from(institutions)
    .where(eq(institutions.ownerEmail, owner));
  const wanted = institutionName.trim().toLowerCase();
  const realPlaidNameCollision = sameName.some(
    (i) => i.name.trim().toLowerCase() === wanted && !isManualInstitution(i),
  );

  const existingManual = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(and(eq(institutions.ownerEmail, owner), eq(institutions.plaidItemId, key)));
  if (existingManual.length > 0) {
    return { institutionId: existingManual[0].id, created: false, realPlaidNameCollision };
  }

  const id = crypto.randomUUID();
  await db.insert(institutions).values({
    id,
    ownerEmail: owner,
    plaidItemId: key,
    plaidInstitutionId: null,
    name: institutionName.trim(),
    accessToken: MANUAL_ACCESS_TOKEN,
    status: "manual",
    defaultProfile: profile,
    createdAt: new Date().toISOString(),
  });
  return { institutionId: id, created: true, realPlaidNameCollision };
}

/** Valid account classes for a manual account (maps to fp_accounts.type). */
export const MANUAL_ACCOUNT_CLASSES = [
  "depository",
  "credit",
  "loan",
  "investment",
  "other",
] as const;
export type ManualAccountClass = (typeof MANUAL_ACCOUNT_CLASSES)[number];
