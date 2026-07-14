/**
 * Read the current owner's active profile ('personal' | 'business').
 * Read-only. Run:  pnpm action get-active-profile
 */
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { ownerEmail } from "../server/lib/owner.js";
import { getActiveProfile } from "../server/lib/profile.js";

export default defineAction({
  description:
    "Get the current active profile ('personal' or 'business'). Every profile-scoped action (transactions, accounts, recurring, rules, categories, saved views, analytics) defaults to this profile unless a per-call profile override is passed.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const owner = ownerEmail();
    const profile = await getActiveProfile(db, owner);
    return { profile };
  },
});
