/**
 * Typed, lazy singleton Drizzle client for Finance domain tables.
 * Import `getDb` from here (../server/db/index.js in actions,
 * ../../server/db/index.js in routes) so schema types come through.
 */
import { createGetDb } from "@agent-native/core/db";
import * as schema from "./schema.js";

export const getDb = createGetDb(schema);
