import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { listProjectionSourceStatuses } from "../server/lib/projection-sources.js";

export default defineAction({
  description:
    "List projected-income source options and configuration status. Shows manual entries, Recurly CSV import, and optional Recurly API automation without exposing secret values.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const sources = await listProjectionSourceStatuses();
    return {
      sources,
      automatedAvailable: sources.some((source) => source.automated && source.configured),
      configured: sources.filter((source) => source.configured).map((source) => source.id),
      missingAutomation: sources
        .filter((source) => source.automated && !source.configured)
        .flatMap((source) => source.missingEnv),
    };
  },
});
