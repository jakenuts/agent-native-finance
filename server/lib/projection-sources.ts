import {
  fetchRecentRenewalActivity,
  fetchUpcomingRenewals,
  type FetchRenewalsResult,
  type RecentRenewalActivityResult,
} from "./recurly.js";
import { hasConfigValues } from "./config-secrets.js";

export type ProjectionSourceId = "manual" | "recurly-csv" | "recurly-api";
export type ProjectionSourceKind = "manual" | "csv" | "api";

export interface ProjectionSourceStatus {
  id: ProjectionSourceId;
  label: string;
  kind: ProjectionSourceKind;
  configured: boolean;
  automated: boolean;
  required: boolean;
  description: string;
  action: string;
  requiredEnv: string[];
  optionalEnv: string[];
  missingEnv: string[];
}

const RECURLY_REQUIRED_ENV = ["RECURLY_API_KEY"];
const RECURLY_OPTIONAL_ENV = ["RECURLY_SUBDOMAIN"];

async function recurlyApiStatus(): Promise<ProjectionSourceStatus> {
  const configured = await hasConfigValues(RECURLY_REQUIRED_ENV);
  return {
    id: "recurly-api",
    label: "Recurly API",
    kind: "api",
    configured,
    automated: true,
    required: false,
    description: "Automated upcoming-renewal projections and recent charge outcomes.",
    action: "sync-recurly-renewals",
    requiredEnv: RECURLY_REQUIRED_ENV,
    optionalEnv: RECURLY_OPTIONAL_ENV,
    missingEnv: configured ? [] : RECURLY_REQUIRED_ENV,
  };
}

export async function listProjectionSourceStatuses(): Promise<ProjectionSourceStatus[]> {
  return [
    {
      id: "manual",
      label: "Manual entries",
      kind: "manual",
      configured: true,
      automated: false,
      required: false,
      description: "One-off expected cash events maintained in the ledger.",
      action: "create-projected-entry",
      requiredEnv: [],
      optionalEnv: [],
      missingEnv: [],
    },
    {
      id: "recurly-csv",
      label: "Recurly CSV",
      kind: "csv",
      configured: true,
      automated: false,
      required: false,
      description: "File-based renewal import that does not require an API key.",
      action: "import-recurly-renewals",
      requiredEnv: [],
      optionalEnv: [],
      missingEnv: [],
    },
    await recurlyApiStatus(),
  ];
}

export async function isProjectionSourceConfigured(
  sourceId: ProjectionSourceId,
): Promise<boolean> {
  const source = (await listProjectionSourceStatuses()).find((s) => s.id === sourceId);
  return Boolean(source?.configured);
}

async function assertRecurlyApiConfigured(): Promise<void> {
  if (await isProjectionSourceConfigured("recurly-api")) return;
  throw new Error(
    "Recurly API projections are not configured. Set RECURLY_API_KEY through setup, scoped secrets, or deployment environment variables.",
  );
}

export async function fetchProjectionSourceRenewals(
  sourceId: Extract<ProjectionSourceId, "recurly-api">,
  days: number,
): Promise<FetchRenewalsResult> {
  if (sourceId !== "recurly-api") {
    throw new Error(`Projection source ${sourceId} does not support API renewal fetches.`);
  }
  await assertRecurlyApiConfigured();
  return fetchUpcomingRenewals(days);
}

export async function fetchProjectionSourceRecentActivity(
  sourceId: Extract<ProjectionSourceId, "recurly-api">,
  days: number,
): Promise<RecentRenewalActivityResult> {
  if (sourceId !== "recurly-api") {
    throw new Error(`Projection source ${sourceId} does not support recent activity.`);
  }
  await assertRecurlyApiConfigured();
  return fetchRecentRenewalActivity(days);
}
