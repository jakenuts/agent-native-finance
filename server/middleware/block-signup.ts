/**
 * Optional signup lock for single-tenant deployments.
 *
 * Reusable templates should allow first-user setup by default. Operators who
 * deploy Finance for a single owner can set FINANCE_BLOCK_SIGNUP=true in
 * production to block new email/password accounts after their owner account
 * exists. Sign-in, sessions, and password reset are untouched.
 */
import { defineEventHandler } from "h3";

// Better Auth mounts under `/_agent-native/auth/ba`; email signup is
// `POST {basePath}/sign-up/email`. endsWith also covers an APP_BASE_PATH prefix.
const SIGNUP_ENDPOINT_SUFFIX = "/_agent-native/auth/ba/sign-up/email";

export default defineEventHandler((event) => {
  const isProd = process.env.NODE_ENV === "production";
  const blockSignup = process.env.FINANCE_BLOCK_SIGNUP === "true";
  if (!isProd || !blockSignup) return;

  const method = (event.method ?? "GET").toUpperCase();
  if (method !== "POST") return;

  const path = (event.path ?? "").split("?")[0];
  if (!path.endsWith(SIGNUP_ENDPOINT_SUFFIX)) return;

  // Returning a Response short-circuits the middleware chain (same mechanism
  // the auth guard uses). Shape matches Better Auth's JSON error so the
  // onboarding form surfaces the message instead of a blank failure.
  return new Response(
    JSON.stringify({ message: "New sign-ups are disabled on this deployment." }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
});
