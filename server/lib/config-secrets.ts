import { resolveSecret } from "@agent-native/core/server";

/**
 * Resolve app/provider configuration from Agent Native scoped secrets first,
 * with deployment environment variables as the fallback. This lets onboarding
 * forms and host-level env vars drive the same runtime code path.
 */
export async function resolveConfigValue(key: string): Promise<string | null> {
  try {
    const value = await resolveSecret(key);
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  } catch {
    // If the scoped secrets table is unavailable, keep deploy envs usable.
  }
  const fallback = process.env[key]?.trim();
  return fallback || null;
}

export async function hasConfigValues(keys: string[]): Promise<boolean> {
  const values = await Promise.all(keys.map((key) => resolveConfigValue(key)));
  return values.every(Boolean);
}
