/**
 * Single-user owner identity. Finance is self-hosted for one person, so we
 * scope rows to a configured owner email. Swap for the authenticated user's
 * identity when multi-user auth is wired.
 */
export function ownerEmail(): string {
  return process.env.FINANCE_OWNER_EMAIL ?? "owner@finance.local";
}
