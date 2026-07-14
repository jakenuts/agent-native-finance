import {
  FeedbackButton,
  navigateWithAgentChatViewTransition,
  useChatThreads,
  useT,
  type ChatThreadSummary,
} from "@agent-native/core/client";
import { ExtensionsSidebarSection } from "@agent-native/core/client/extensions";
import { OrgSwitcher } from "@agent-native/core/client/org";
import {
  IconActivity,
  IconActivityHeartbeat,
  IconArchive,
  IconBuildingBank,
  IconCalendarStats,
  IconChartBar,
  IconChartPie,
  IconCategory,
  IconChevronRight,
  IconPigMoney,
  IconShieldCheck,
  IconDatabase,
  IconDots,
  IconEdit,
  IconLayoutDashboard,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMessageCircle,
  IconPin,
  IconPlugConnected,
  IconPlus,
  IconReceipt2,
  IconRepeat,
  IconSettings,
  IconTrendingUp,
  IconUpload,
  IconWand,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

interface NavItem {
  icon: typeof IconLayoutDashboard;
  labelKey: string;
  href: string;
  view: string;
}

/** Day-to-day analysis surfaces — the "look at my money" pages. */
const analyzeItems: NavItem[] = [
  {
    icon: IconLayoutDashboard,
    labelKey: "navigation.dashboard",
    href: "/dashboard",
    view: "dashboard",
  },
  {
    icon: IconChartBar,
    labelKey: "navigation.spending",
    href: "/spending",
    view: "spending",
  },
  {
    icon: IconReceipt2,
    labelKey: "navigation.transactions",
    href: "/transactions",
    view: "transactions",
  },
  {
    icon: IconRepeat,
    labelKey: "navigation.recurring",
    href: "/recurring",
    view: "recurring",
  },
  {
    icon: IconShieldCheck,
    labelKey: "navigation.plans",
    href: "/plans",
    view: "plans",
  },
  {
    icon: IconCalendarStats,
    labelKey: "navigation.runway",
    href: "/runway",
    view: "runway",
  },
  {
    icon: IconTrendingUp,
    labelKey: "navigation.projections",
    href: "/projections",
    view: "projections",
  },
  {
    icon: IconPigMoney,
    labelKey: "navigation.budgets",
    href: "/budgets",
    view: "budgets",
  },
  {
    icon: IconChartPie,
    labelKey: "navigation.views",
    href: "/views",
    view: "views",
  },
];

/** Setup & upkeep — accounts, categorization machinery, data in/out. */
const manageItems: NavItem[] = [
  {
    icon: IconBuildingBank,
    labelKey: "navigation.accounts",
    href: "/accounts",
    view: "accounts",
  },
  {
    icon: IconCategory,
    labelKey: "navigation.categories",
    href: "/categories",
    view: "categories",
  },
  {
    icon: IconWand,
    labelKey: "navigation.rules",
    href: "/rules",
    view: "rules",
  },
  {
    icon: IconPlugConnected,
    labelKey: "navigation.connect",
    href: "/connect",
    view: "connect",
  },
  {
    icon: IconUpload,
    labelKey: "navigation.import",
    href: "/import",
    view: "import",
  },
];

const chatItem: NavItem = {
  icon: IconMessageCircle,
  labelKey: "navigation.chat",
  href: "/chat",
  view: "chat",
};

/** Rarely-visited internals — collapsed by default behind the System group. */
const systemItems: NavItem[] = [
  {
    icon: IconActivity,
    labelKey: "navigation.observability",
    href: "/observability",
    view: "observability",
  },
  {
    icon: IconDatabase,
    labelKey: "navigation.database",
    href: "/database",
    view: "database",
  },
  {
    icon: IconSettings,
    labelKey: "navigation.settings",
    href: "/settings",
    view: "settings",
  },
];

const SYSTEM_GROUP_OPEN_KEY = "finance:nav-system-open";

const CHAT_STORAGE_KEY = "chat";
const CHAT_ACTIVE_THREAD_KEY = `agent-chat-active-thread:${CHAT_STORAGE_KEY}`;

interface SidebarProps {
  collapsed?: boolean;
  collapsible?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

function formatThreadAge(updatedAt: number) {
  const diffMs = Math.max(0, Date.now() - updatedAt);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(updatedAt).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function threadTitle(thread: ChatThreadSummary) {
  return thread.title || thread.preview || "Untitled chat";
}

function threadUpdatedAt(thread: ChatThreadSummary) {
  return Number.isFinite(thread.updatedAt)
    ? thread.updatedAt
    : Number.isFinite(thread.createdAt)
      ? thread.createdAt
      : 0;
}

function compareThreads(a: ChatThreadSummary, b: ChatThreadSummary) {
  const aPinned = a.pinnedAt ?? 0;
  const bPinned = b.pinnedAt ?? 0;
  if (aPinned || bPinned) return bPinned - aPinned;
  return threadUpdatedAt(b) - threadUpdatedAt(a);
}

function persistedActiveThreadId() {
  try {
    return localStorage.getItem(CHAT_ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

function threadIdFromPath(pathname: string) {
  const match = pathname.match(/^\/chat\/([^/]+)/);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]).trim();
    return value || null;
  } catch {
    return null;
  }
}

function chatThreadPath(threadId: string) {
  return `/chat/${encodeURIComponent(threadId)}`;
}

function ChatThreadsSection() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  const {
    threads,
    activeThreadId,
    createThread,
    switchThread,
    pinThread,
    archiveThread,
    renameThread,
    refreshThreads,
  } = useChatThreads(undefined, CHAT_STORAGE_KEY, undefined, {
    autoCreate: false,
    restoreActiveThread: false,
  });
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const committingRenameRef = useRef(false);

  const visibleThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.messageCount > 0 && !thread.archivedAt)
        .sort(compareThreads)
        .slice(0, 12),
    [threads],
  );

  useEffect(() => {
    const refresh = () => refreshThreads();
    const handleRunning = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { isRunning?: unknown }
        | undefined;
      if (typeof detail?.isRunning === "boolean") refreshThreads();
    };

    window.addEventListener("agent-chat:threads-updated", refresh);
    window.addEventListener("agentNative.chatRunning", handleRunning);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refresh);
      window.removeEventListener("agentNative.chatRunning", handleRunning);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshThreads]);

  useEffect(() => {
    if (!renamingThreadId) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingThreadId]);

  function openThread(threadId: string, options?: { isNew?: boolean }) {
    switchThread(threadId);
    navigateWithAgentChatViewTransition(
      navigate,
      options?.isNew ? "/" : chatThreadPath(threadId),
    );
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("agent-chat:open-thread", {
          detail: { threadId, newThread: options?.isNew === true },
        }),
      );
    });
  }

  async function handleNewChat() {
    const threadId = await createThread();
    if (threadId) openThread(threadId, { isNew: true });
  }

  async function handleArchiveThread(threadId: string) {
    const wasActive =
      threadId === activeThreadId || threadId === persistedActiveThreadId();
    const archived = await archiveThread(threadId);
    if (!archived) {
      toast.error(t("chat.archiveFailed"));
      return;
    }
    if (wasActive) {
      await handleNewChat();
    }
  }

  function startRenameThread(thread: ChatThreadSummary) {
    committingRenameRef.current = false;
    setRenameDraft(threadTitle(thread));
    setRenamingThreadId(thread.id);
  }

  function cancelRenameThread() {
    committingRenameRef.current = true;
    setRenamingThreadId(null);
    setRenameDraft("");
  }

  async function commitRenameThread() {
    if (committingRenameRef.current) return;
    const threadId = renamingThreadId;
    const title = renameDraft.trim();
    if (!threadId) return;
    committingRenameRef.current = true;
    setRenamingThreadId(null);
    setRenameDraft("");
    if (title) {
      const renamed = await renameThread(threadId, title);
      if (!renamed) toast.error(t("chat.renameFailed"));
    }
    committingRenameRef.current = false;
  }

  function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void commitRenameThread();
  }

  return (
    <div className="mt-2 border-s border-sidebar-border/70 ps-3">
      <div className="mb-1 flex h-7 items-center gap-2 pe-1">
        <div className="min-w-0 flex-1 text-xs font-medium text-sidebar-foreground/70">
          {t("chat.chats")}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleNewChat}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label={t("chat.newChat")}
            >
              <IconPlus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("chat.newChat")}</TooltipContent>
        </Tooltip>
      </div>
      <div className="grid gap-0.5">
        {visibleThreads.map((thread) => {
          const isActive =
            thread.id ===
            (threadIdFromPath(location.pathname) ??
              (location.pathname === "/" ? null : activeThreadId));
          const isRenaming = thread.id === renamingThreadId;
          return (
            <div
              key={thread.id}
              className={cn(
                "group flex h-8 min-w-0 items-center rounded-md text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/65 hover:text-sidebar-accent-foreground",
              )}
            >
              {isRenaming ? (
                <form
                  onSubmit={handleRenameSubmit}
                  className="flex h-full min-w-0 flex-1 items-center px-1.5"
                >
                  <Input
                    ref={renameInputRef}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={() => void commitRenameThread()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRenameThread();
                      }
                    }}
                    maxLength={160}
                    aria-label={t("chat.renameThread", {
                      title: threadTitle(thread),
                    })}
                    className="h-6 min-w-0 rounded-sm border-sidebar-border bg-background px-1.5 text-xs"
                  />
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => openThread(thread.id)}
                    className="flex h-full min-w-0 flex-1 items-center px-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {threadTitle(thread)}
                    </span>
                  </button>
                  <div className="relative flex size-7 shrink-0 items-center justify-end pe-1">
                    <span className="text-[11px] text-sidebar-foreground/50 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                      {isActive ? "" : formatThreadAge(threadUpdatedAt(thread))}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t("chat.optionsFor", {
                            title: threadTitle(thread),
                          })}
                          className="absolute end-1 flex size-6 items-center justify-center rounded-md text-sidebar-foreground/65 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
                        >
                          <IconDots className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        side="right"
                        sideOffset={6}
                      >
                        <DropdownMenuItem
                          onSelect={() => startRenameThread(thread)}
                        >
                          <IconEdit className="size-4" />
                          {t("chat.renameChat")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            void pinThread(thread.id, !thread.pinnedAt)
                          }
                        >
                          <IconPin className="size-4" />
                          {thread.pinnedAt
                            ? t("chat.unpinChat")
                            : t("chat.pinChat")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                          onSelect={() => void handleArchiveThread(thread.id)}
                        >
                          <IconArchive className="size-4" />
                          {t("chat.archiveChat")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Sidebar({
  collapsed = false,
  collapsible = true,
  onCollapsedChange,
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const isChatRoute =
    location.pathname === "/" || location.pathname.startsWith("/chat/");
  const systemRouteActive =
    systemItems.some((item) => location.pathname.startsWith(item.href)) ||
    location.pathname.startsWith("/extensions") ||
    location.pathname.startsWith("/team");
  const [systemOpen, setSystemOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(SYSTEM_GROUP_OPEN_KEY) === "1",
  );

  // Never hide the active page: landing on a system route opens the group
  // (without persisting — only an explicit toggle writes localStorage).
  useEffect(() => {
    if (systemRouteActive) setSystemOpen(true);
  }, [systemRouteActive]);

  const systemExpanded = systemOpen;

  function toggleSystemGroup() {
    setSystemOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SYSTEM_GROUP_OPEN_KEY, next ? "1" : "0");
      } catch {
        // Ignore storage access errors.
      }
      return next;
    });
  }
  const ToggleIcon = collapsed
    ? IconLayoutSidebarLeftExpand
    : IconLayoutSidebarLeftCollapse;
  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center text-sm transition-colors",
      collapsed
        ? "relative h-10 w-full justify-center rounded-none border-s-2 px-0"
        : "h-9 rounded-md gap-3 px-3",
      isActive
        ? collapsed
          ? "border-s-sidebar-accent-foreground/80 bg-sidebar-accent text-sidebar-accent-foreground"
          : "bg-sidebar-accent text-sidebar-accent-foreground"
        : collapsed
          ? "border-s-transparent text-sidebar-foreground/70 hover:bg-sidebar-accent/55 hover:text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/65 hover:text-sidebar-accent-foreground",
    );
  function renderGroupLabel(label: string, first = false) {
    if (collapsed) return null;
    return (
      <p
        className={cn(
          "px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50",
          first ? "pt-1" : "pt-4",
        )}
      >
        {label}
      </p>
    );
  }

  function renderGroupSeparator(key: string) {
    return <div key={key} className="mx-2 my-1.5 border-t border-sidebar-border/70" />;
  }

  function renderNavItem(item: NavItem) {
    const Icon = item.icon;
    const isActive =
      item.href === "/" ? isChatRoute : location.pathname.startsWith(item.href);
    const link = (
      <Link
        to={item.href}
        onClick={(event) => {
          if (
            item.href === "/" &&
            !isChatRoute &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            navigateWithAgentChatViewTransition(navigate, "/");
          }
        }}
        className={navClass({ isActive })}
        aria-current={isActive ? "page" : undefined}
        aria-label={collapsed ? t(item.labelKey) : undefined}
      >
        <Icon className="size-4 shrink-0" />
        <span className={collapsed ? "sr-only" : "truncate"}>
          {t(item.labelKey)}
        </span>
      </Link>
    );
    return (
      <div key={item.href}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
          </Tooltip>
        ) : (
          link
        )}
        {!collapsed && item.view === "chat" && isChatRoute ? (
          <ChatThreadsSection />
        ) : null}
      </div>
    );
  }

  const collapseButton = collapsible ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onCollapsedChange?.(!collapsed)}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            collapsed ? "size-8" : "size-7",
          )}
          aria-label={
            collapsed
              ? t("navigation.expandSidebar")
              : t("navigation.collapseSidebar")
          }
        >
          <ToggleIcon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {collapsed
          ? t("navigation.expandSidebar")
          : t("navigation.collapseSidebar")}
      </TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out",
        // In the mobile Sheet (collapsible === false) fill the drawer width so
        // there's no grey gap on the right and the close button sits over the
        // panel; desktop keeps the fixed collapsed/expanded widths.
        collapsible === false ? "w-full" : collapsed ? "w-12" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center border-b border-sidebar-border",
          collapsed ? "h-12 justify-center px-0" : "h-14 px-3",
        )}
      >
        <Link
          to="/dashboard"
          className={cn(
            "flex min-w-0 items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring",
            collapsed ? "size-7 justify-center" : "flex-1 gap-2.5",
          )}
          aria-label={collapsed ? APP_TITLE : undefined}
        >
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary">
            <IconActivityHeartbeat className="size-4 text-primary-foreground" />
          </div>
          <div className={cn("min-w-0", collapsed && "sr-only")}>
            <p className="truncate text-sm font-semibold tracking-tight text-sidebar-accent-foreground">
              {APP_TITLE}
            </p>
          </div>
        </Link>
      </div>

      <nav
        className={cn(
          "flex-1 overflow-y-auto",
          collapsed ? "px-0 py-2" : "px-2 py-2",
        )}
      >
        {renderGroupLabel(t("navigation.analyze"), true)}
        <div className={cn("grid", collapsed ? "gap-0" : "gap-0.5")}>
          {analyzeItems.map(renderNavItem)}
        </div>

        {collapsed ? renderGroupSeparator("analyze-sep") : null}
        {renderGroupLabel(t("navigation.manage"))}
        <div className={cn("grid", collapsed ? "gap-0" : "gap-0.5")}>
          {manageItems.map(renderNavItem)}
        </div>

        {collapsed ? renderGroupSeparator("chat-sep") : <div className="pt-3" />}
        <div className={cn("grid", collapsed ? "gap-0" : "gap-0.5")}>
          {renderNavItem(chatItem)}
        </div>

        {collapsed ? (
          <>
            {renderGroupSeparator("system-sep")}
            <div className="grid gap-0">{systemItems.map(renderNavItem)}</div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={toggleSystemGroup}
              aria-expanded={systemExpanded}
              className="mt-3 flex h-7 w-full items-center gap-1 rounded-md px-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("navigation.system")}
              <IconChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  systemExpanded && "rotate-90",
                )}
              />
            </button>
            {systemExpanded ? (
              <div className="grid gap-0.5">
                {systemItems.map(renderNavItem)}
                <div className="px-0 py-1">
                  <ExtensionsSidebarSection />
                </div>
                <div className="px-1 pb-1">
                  <FeedbackButton variant="sidebar" side="right" align="end" />
                </div>
              </div>
            ) : null}
          </>
        )}
      </nav>

      <div className={cn("mt-auto shrink-0", collapsed && "py-2")}>
        <div className={cn(collapsed ? "px-1 py-1" : "px-3 py-2")}>
          <OrgSwitcher
            reserveSpace
            className={
              collapsed
                ? "h-8 justify-center px-0 [&>span]:sr-only [&>svg:last-child]:hidden"
                : undefined
            }
          />
        </div>

        {collapsed ? (
          <div className="flex justify-center px-1 py-1">
            <FeedbackButton variant="icon" side="right" align="center" />
          </div>
        ) : null}

        {collapseButton ? (
          <div
            className={cn(
              collapsed
                ? "flex justify-center px-1 py-1"
                : "flex justify-end px-3 py-2",
            )}
          >
            {collapseButton}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
