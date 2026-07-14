/**
 * Exchange a Link public_token (from the browser onSuccess) for a persistent
 * access token, store the institution + accounts, and run an initial sync.
 * Run:  pnpm action plaid-exchange-public-token --publicToken <token>
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { getPlaid } from "../server/lib/plaid.js";
import { onboardAccessToken } from "../server/lib/finance-sync.js";
import { getDb } from "../server/db/index.js";
import { accounts, institutions } from "../server/db/schema.js";
import { ownerEmail } from "../server/lib/owner.js";
import { resolveEffectiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Exchange a Plaid Link public_token for an access token and import the bank's accounts + transactions. The institution's default_profile (and its accounts) are set from `profile`, defaulting to the active profile — pick 'business' when connecting a business-only login.",
  schema: z.object({
    publicToken: z.string().describe("public_token from Plaid Link onSuccess."),
    institutionId: z
      .string()
      .optional()
      .describe("Plaid institution_id from Link metadata."),
    profile: z
      .enum(["personal", "business"])
      .optional()
      .describe("Profile for this institution's accounts. Defaults to the active profile."),
  }),
  run: async ({ publicToken, institutionId, profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    const effectiveProfile = await resolveEffectiveProfile(db, owner, profile);
    const plaid = await getPlaid();
    const exchange = await plaid.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const result = await onboardAccessToken(db, {
      ownerEmail: owner,
      accessToken: exchange.data.access_token,
      itemId: exchange.data.item_id,
      plaidInstitutionId: institutionId ?? null,
      defaultProfile: effectiveProfile === "all" ? "personal" : effectiveProfile,
    });

    // Duplicate-Item guard: this is the #1 cause of the "three Bank of
    // America institutions" problem — re-linking the same bank login through
    // a fresh Connect flow (instead of Link update mode) mints a SECOND Item.
    // We still onboard it (the user may have deliberately added a second
    // login), but flag any OTHER institution with the same plaid_institution_id
    // and at least one overlapping account mask so the UI can prompt a merge.
    let duplicateOfInstitutionId: string | null = null;
    let duplicateOfInstitutionName: string | null = null;
    if (institutionId) {
      const otherInstitutions = await db
        .select({ id: institutions.id, name: institutions.name })
        .from(institutions)
        .where(
          and(
            eq(institutions.ownerEmail, owner),
            eq(institutions.plaidInstitutionId, institutionId),
            ne(institutions.id, result.institutionId),
          ),
        );
      if (otherInstitutions.length > 0) {
        const newAccountMasks = new Set(
          (
            await db
              .select({ mask: accounts.mask })
              .from(accounts)
              .where(eq(accounts.institutionId, result.institutionId))
          )
            .map((a) => a.mask)
            .filter((m): m is string => Boolean(m)),
        );
        for (const other of otherInstitutions) {
          const otherMasks = await db
            .select({ mask: accounts.mask })
            .from(accounts)
            .where(eq(accounts.institutionId, other.id));
          const overlaps = otherMasks.some((a) => a.mask && newAccountMasks.has(a.mask));
          if (overlaps) {
            duplicateOfInstitutionId = other.id;
            duplicateOfInstitutionName = other.name;
            break;
          }
        }
      }
    }

    return { ok: true, ...result, duplicateOfInstitutionId, duplicateOfInstitutionName };
  },
});
