/**
 * Switch the current owner's active profile ('personal' | 'business'). This
 * is the single toggle behind the Header's profile switcher — the agent can
 * call it directly for parity (e.g. "switch to business and show me last
 * month's spending").
 * Run:  pnpm action set-active-profile --profile business
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { ownerEmail } from "../server/lib/owner.js";
import { setActiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Switch the active profile to 'personal' or 'business'. Every profile-scoped action (list-transactions, list-accounts, spending-summary, run-finance-query, recurring, rules, categories, saved views) defaults to this profile from then on, and new records the agent/UI creates are tagged with it.",
  schema: z.object({
    profile: z.enum(["personal", "business"]),
  }),
  readOnly: false,
  run: async ({ profile }) => {
    const db = getDb();
    const owner = ownerEmail();
    await setActiveProfile(db, owner, profile);
    return { ok: true, profile };
  },
});
