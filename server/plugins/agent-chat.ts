import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "finance-summary",
  "list-accounts",
  "list-transactions",
  "get-runway",
];

export default createAgentChatPlugin({
  appId: "finance",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the Finance agent.

Finance manages a mixed personal and business financial picture. It syncs banking data from Plaid, categorizes transactions, tracks recurring obligations, models critical payment plans, and projects runway using real balances plus scheduled and projected cash events.

Use actions as the source of truth. Start by inspecting the current screen when context matters, and respect the active personal/business profile unless the user clearly asks for another scope. Treat payment plans as critical obligations, distinguish unverified funding from real warnings, and avoid alarming language unless the returned action data marks a plan or runway item as genuinely at risk.`,
});
