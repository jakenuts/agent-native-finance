/**
 * Personal/Business profile resolution. Finance's single owner can have both
 * personal and business accounts (sometimes at the same institution), and
 * every profile-scoped table (accounts, transactions, recurring, rules,
 * categories, saved views) carries a `profile` column. The "active profile"
 * is a per-owner setting (fp_settings, key='active_profile') that the agent
 * and UI both read/write via get-active-profile / set-active-profile so they
 * stay in sync — this is the single source of truth for "which mode are we
 * in right now."
 */
import { and, eq } from "drizzle-orm";
import { settings } from "../db/schema.js";

type Db = ReturnType<typeof import("../db/index.js").getDb>;

export type Profile = "personal" | "business";
/** Many list/analytics actions also accept 'all' to bypass profile scoping. */
export type ProfileFilter = Profile | "all";

export const ACTIVE_PROFILE_KEY = "active_profile";
const DEFAULT_PROFILE: Profile = "personal";

export function isProfile(value: unknown): value is Profile {
  return value === "personal" || value === "business";
}

/** Read the owner's active profile, defaulting to 'personal' if unset. */
export async function getActiveProfile(db: Db, owner: string): Promise<Profile> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.ownerEmail, owner), eq(settings.key, ACTIVE_PROFILE_KEY)));
  const value = rows[0]?.value;
  return isProfile(value) ? value : DEFAULT_PROFILE;
}

/** Persist the owner's active profile (select-then-write upsert). */
export async function setActiveProfile(db: Db, owner: string, profile: Profile): Promise<void> {
  const id = `${owner}:${ACTIVE_PROFILE_KEY}`;
  const existing = await db
    .select({ id: settings.id })
    .from(settings)
    .where(and(eq(settings.ownerEmail, owner), eq(settings.key, ACTIVE_PROFILE_KEY)));
  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value: profile })
      .where(eq(settings.id, existing[0].id));
  } else {
    await db.insert(settings).values({
      id,
      ownerEmail: owner,
      key: ACTIVE_PROFILE_KEY,
      value: profile,
    });
  }
}

/**
 * Resolve the effective profile filter for an action: an explicit override
 * param wins ('personal' | 'business' | 'all'); otherwise fall back to the
 * owner's active profile. Used by every profile-scoped list/analytics action.
 */
export async function resolveEffectiveProfile(
  db: Db,
  owner: string,
  override?: ProfileFilter | null,
): Promise<ProfileFilter> {
  if (override === "personal" || override === "business" || override === "all") {
    return override;
  }
  return getActiveProfile(db, owner);
}
