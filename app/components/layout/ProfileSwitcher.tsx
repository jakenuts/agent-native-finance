import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import { IconBriefcase, IconUser } from "@tabler/icons-react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/**
 * Personal | Business toggle for the header. Backed by get-active-profile /
 * set-active-profile so the agent and UI share the same "which mode are we
 * in" state — switching here immediately re-scopes every profile-aware
 * action (transactions, accounts, recurring, rules, categories, saved views,
 * analytics) via the framework's action-query cache invalidation.
 */
export function ProfileSwitcher() {
  const queryClient = useQueryClient();
  const profileQuery = useActionQuery("get-active-profile", {});
  const setProfile = useActionMutation("set-active-profile");

  const activeProfile = profileQuery.data?.profile ?? "personal";

  function handleChange(value: string) {
    if (!value || value === activeProfile) return;
    setProfile.mutate(
      { profile: value as "personal" | "business" },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["action"] });
        },
      },
    );
  }

  return (
    <ToggleGroup
      type="single"
      value={activeProfile}
      onValueChange={handleChange}
      className="gap-0 rounded-full border border-border bg-muted/40 p-0.5"
      aria-label="Active profile"
    >
      <ToggleGroupItem
        value="personal"
        size="sm"
        aria-label="Personal profile"
        className={cn(
          "gap-1.5 rounded-full px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm sm:px-3",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            activeProfile === "personal" ? "bg-fin-positive" : "bg-muted-foreground/40",
          )}
        />
        <IconUser className="size-3.5" />
        <span className="hidden sm:inline">Personal</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        value="business"
        size="sm"
        aria-label="Business profile"
        className={cn(
          "gap-1.5 rounded-full px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm sm:px-3",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            activeProfile === "business" ? "bg-fin-positive" : "bg-muted-foreground/40",
          )}
        />
        <IconBriefcase className="size-3.5" />
        <span className="hidden sm:inline">Business</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
