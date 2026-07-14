/**
 * /views — grid of all saved views (agent-crafted charts, tables, and
 * metrics). The agent creates and maintains these via the saved-view actions.
 */
import { useActionQuery } from "@agent-native/core/client";
import { IconChartPie, IconSparkles } from "@tabler/icons-react";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import {
  SavedViewCard,
  type SavedViewConfig,
  type SavedViewRow,
} from "@/components/finance/SavedViewCard";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Views - ${APP_TITLE}` }];
}

interface ListSavedViewsResult {
  views: Array<{
    id: string;
    name: string;
    description: string | null;
    kind: string;
    config: SavedViewConfig | null;
    position: number;
    isPinned: boolean;
  }>;
}

export default function ViewsRoute() {
  useSetPageTitle("Views");
  const viewsQuery = useActionQuery<ListSavedViewsResult>("list-saved-views", {});

  const views: SavedViewRow[] = (viewsQuery.data?.views ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    description: v.description,
    kind: v.kind,
    config: v.config,
    isPinned: v.isPinned,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      <div className="flex items-center gap-3">
        <IconChartPie className="size-6 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Views</h1>
          <p className="text-sm text-muted-foreground">
            Persistent charts, tables, and metrics the agent builds for you.
          </p>
        </div>
      </div>

      {viewsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-80 w-full" />
          ))}
        </div>
      ) : views.length === 0 ? (
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <IconSparkles className="size-8 text-primary" />
            <div>
              <p className="text-base font-medium">No saved views yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Ask the agent to create views for you — for example, &ldquo;show my
                monthly grocery trend as a chart&rdquo; or &ldquo;build a subscriptions
                report&rdquo;. Views live here permanently and stay up to date with your
                transactions.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="columns-1 gap-4 lg:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
          {views.map((view) => (
            <SavedViewCard key={view.id} view={view} showPinToggle />
          ))}
        </div>
      )}
    </div>
  );
}
