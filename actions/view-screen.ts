/**
 * See what the user is currently looking at on screen.
 *
 * Reads and returns the current navigation state from application state.
 *
 * Usage:
 *   pnpm action view-screen
 */

import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { ownerEmail } from "../server/lib/owner.js";
import { getActiveProfile } from "../server/lib/profile.js";
import { listProjectionSourceStatuses } from "../server/lib/projection-sources.js";

export default defineAction({
  description:
    "See what the user is currently looking at on screen. Returns the current navigation state and activeProfile ('personal'/'business') for the chat-first app. Always call this first before taking any action — activeProfile tells you which profile every profile-scoped action defaults to unless you pass an explicit override.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppState("navigation");
    const activeProfile = await getActiveProfile(getDb(), ownerEmail());

    const screen: Record<string, unknown> = { activeProfile };
    if (navigation) screen.navigation = navigation;
    if (
      navigation &&
      typeof navigation === "object" &&
      "view" in navigation &&
      navigation.view === "projections"
    ) {
      screen.projectionSources = await listProjectionSourceStatuses();
    }

    return screen;
  },
});
