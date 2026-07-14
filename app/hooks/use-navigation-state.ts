import {
  appBasePath,
  appPath,
  markAgentChatHomeHandoff,
  useAgentRouteState,
} from "@agent-native/core/client";
import { useLocation } from "react-router";

import { TAB_ID } from "@/lib/tab-id";

export interface NavigationState {
  view: string;
  path?: string;
  threadId?: string;
}

export function useNavigationState() {
  const location = useLocation();
  useAgentRouteState<NavigationState>({
    browserTabId: TAB_ID,
    requestSource: TAB_ID,
    getNavigationState: ({ pathname }) => {
      const threadId = threadIdFromPath(pathname);
      return {
        view: viewForPath(pathname),
        path: appPath(pathname),
        ...(threadId ? { threadId } : {}),
      };
    },
    getCommandPath: (command) =>
      routerPath(command.path || pathForCommand(command)),
    onNavigate: (_command, path) => {
      if (
        isChatPath(location.pathname) &&
        !isChatPath(pathnameFromPath(path))
      ) {
        markAgentChatHomeHandoff("chat");
      }
    },
  });
}

function pathnameFromPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

function threadIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/]+)/);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]).trim();
    return value || null;
  } catch {
    return null;
  }
}

function viewForPath(pathname: string): string {
  if (isChatPath(pathname)) return "chat";
  if (pathname.startsWith("/dashboard")) return "dashboard";
  if (pathname.startsWith("/spending")) return "spending";
  if (pathname.startsWith("/transactions")) return "transactions";
  if (pathname.startsWith("/recurring")) return "recurring";
  if (pathname.startsWith("/rules")) return "rules";
  if (pathname.startsWith("/categories")) return "categories";
  if (pathname.startsWith("/runway")) return "runway";
  if (pathname.startsWith("/projections")) return "projections";
  if (pathname.startsWith("/budgets")) return "budgets";
  if (pathname.startsWith("/accounts")) return "accounts";
  if (pathname.startsWith("/connect")) return "connect";
  if (pathname.startsWith("/import")) return "import";
  if (pathname.startsWith("/views")) return "views";
  if (pathname.startsWith("/database")) return "database";
  if (pathname.startsWith("/extensions")) return "extensions";
  if (pathname.startsWith("/observability")) return "observability";
  if (pathname.startsWith("/team")) return "settings";
  // "/" now redirects to the dashboard (the home), and any unknown path falls
  // back to the dashboard rather than the (now dedicated) chat surface.
  return "dashboard";
}

function pathForView(view?: string): string {
  switch (view) {
    case "chat":
    case "ask":
      return "/chat";
    case "home":
      return "/dashboard";
    case "dashboard":
      return "/dashboard";
    case "spending":
      return "/spending";
    case "transactions":
      return "/transactions";
    case "recurring":
      return "/recurring";
    case "rules":
      return "/rules";
    case "categories":
      return "/categories";
    case "runway":
      return "/runway";
    case "projections":
      return "/projections";
    case "budgets":
      return "/budgets";
    case "accounts":
      return "/accounts";
    case "connect":
      return "/connect";
    case "import":
      return "/import";
    case "views":
      return "/views";
    case "database":
      return "/database";
    case "extensions":
      return "/extensions";
    case "observability":
      return "/observability";
    case "settings":
      return "/settings";
    case "team":
      return "/settings#team";
    default:
      return "/dashboard";
  }
}

function pathForCommand(command: any): string {
  const path = pathForView(command?.view);
  if (path !== "/chat") return path;
  const threadId =
    typeof command?.threadId === "string" ? command.threadId.trim() : "";
  return threadId ? `/chat/${encodeURIComponent(threadId)}` : "/chat";
}

function routerPath(path: string): string {
  const basePath = appBasePath();
  if (!basePath) return path;
  if (path === basePath) return "/";
  if (path.startsWith(`${basePath}/`)) {
    return path.slice(basePath.length) || "/";
  }
  return path;
}

function isChatPath(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}
