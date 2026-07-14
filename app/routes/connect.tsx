import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconBriefcase,
  IconBuildingBank,
  IconCircleCheck,
  IconLock,
  IconReceipt2,
  IconSettings,
  IconShieldCheck,
  IconUser,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from "react-plaid-link";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Connect a bank - ${APP_TITLE}` }];
}

interface ConnectedResult {
  institutionId: string;
  accounts: number;
  transactions: number;
  duplicateOfInstitutionId?: string | null;
  duplicateOfInstitutionName?: string | null;
}

interface RefreshedResult {
  institutionId: string;
  institutionName: string;
  accounts: number;
  transactions: number;
}

export default function ConnectRoute() {
  useSetPageTitle("Connect a bank");
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  // ?institutionId=<id> puts this page in UPDATE MODE: reopen Link against an
  // EXISTING Plaid Item to add/remove authorized accounts, instead of
  // starting a brand-new connection (which would create a duplicate Item).
  const updateModeInstitutionId = searchParams.get("institutionId");

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connected, setConnected] = useState<ConnectedResult | null>(null);
  const [refreshed, setRefreshed] = useState<RefreshedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // OAuth institutions redirect the browser away and back; on return the URL
  // carries oauth_state_id and Link must resume with the SAME link token.
  const [oauthRedirectUri, setOauthRedirectUri] = useState<string | null>(null);
  const [profile, setProfile] = useState<"personal" | "business" | null>(null);
  const [isUpdateMode, setIsUpdateMode] = useState(false);
  const [updateModeBankName, setUpdateModeBankName] = useState<string | null>(null);

  const activeProfileQuery = useActionQuery("get-active-profile", {});
  const selectedProfile = profile ?? activeProfileQuery.data?.profile ?? "personal";

  const createLinkToken = useActionMutation("plaid-create-link-token");
  const exchangeToken = useActionMutation("plaid-exchange-public-token");
  const refreshAccounts = useActionMutation("plaid-refresh-accounts");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("oauth_state_id")) return;
    const stored = sessionStorage.getItem("plaid_link_token");
    if (stored) {
      setOauthRedirectUri(window.location.href);
      setLinkToken(stored);
      if (sessionStorage.getItem("plaid_link_update_mode") === "true") {
        setIsUpdateMode(true);
        setUpdateModeBankName(sessionStorage.getItem("plaid_link_update_bank_name"));
      }
    } else {
      setError("OAuth return detected but no Link session found — click Connect to retry.");
    }
  }, []);

  async function handleConnectClick() {
    setError(null);
    setConnected(null);
    setRefreshed(null);
    createLinkToken.mutate(
      updateModeInstitutionId ? { institutionId: updateModeInstitutionId } : {},
      {
        onSuccess: (result) => {
          sessionStorage.setItem("plaid_link_token", result.linkToken); // survives OAuth redirect
          if (result.updateMode) {
            sessionStorage.setItem("plaid_link_update_mode", "true");
            sessionStorage.setItem("plaid_link_update_bank_name", result.institutionName ?? "");
          } else {
            sessionStorage.removeItem("plaid_link_update_mode");
            sessionStorage.removeItem("plaid_link_update_bank_name");
          }
          setIsUpdateMode(result.updateMode);
          setUpdateModeBankName(result.institutionName ?? null);
          setOauthRedirectUri(null);
          setLinkToken(result.linkToken);
        },
        onError: (err) =>
          setError(err instanceof Error ? err.message : "Could not start Plaid Link."),
      },
    );
  }

  function handleSuccess(publicToken: string, metadata: PlaidLinkOnSuccessMetadata) {
    // Update mode: Link's onSuccess fires but there's no new public_token to
    // exchange (the Item already has an access token) — just refresh accounts.
    if (isUpdateMode && updateModeInstitutionId) {
      refreshAccounts.mutate(
        { institutionId: updateModeInstitutionId },
        {
          onSuccess: (result) => {
            setRefreshed(result);
            setLinkToken(null);
            queryClient.invalidateQueries({ queryKey: ["action"] });
            toast.success(
              `Updated ${result.institutionName}: ${result.accounts} account${result.accounts === 1 ? "" : "s"} now authorized.`,
            );
          },
          onError: (err) => {
            setError(err instanceof Error ? err.message : "Could not refresh accounts.");
            setLinkToken(null);
          },
        },
      );
      return;
    }

    exchangeToken.mutate(
      {
        publicToken,
        institutionId: metadata.institution?.institution_id,
        profile: selectedProfile,
      },
      {
        onSuccess: (result) => {
          setConnected(result);
          setLinkToken(null);
          queryClient.invalidateQueries({ queryKey: ["action"] });
          toast.success(
            `Connected ${metadata.institution?.name ?? "your bank"}: ${result.accounts} account${result.accounts === 1 ? "" : "s"}, ${result.transactions} transaction${result.transactions === 1 ? "" : "s"}.`,
          );
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : "Could not finish connecting.");
          setLinkToken(null);
        },
      },
    );
  }

  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    ...(oauthRedirectUri ? { receivedRedirectUri: oauthRedirectUri } : {}),
    onSuccess: (publicToken, metadata) => {
      sessionStorage.removeItem("plaid_link_token");
      sessionStorage.removeItem("plaid_link_update_mode");
      sessionStorage.removeItem("plaid_link_update_bank_name");
      handleSuccess(publicToken, metadata);
    },
    onExit: (plaidError) => {
      sessionStorage.removeItem("plaid_link_token");
      sessionStorage.removeItem("plaid_link_update_mode");
      sessionStorage.removeItem("plaid_link_update_bank_name");
      setLinkToken(null);
      setOauthRedirectUri(null);
      if (plaidError) {
        setError(plaidError.display_message || plaidError.error_message || "Plaid Link exited.");
      }
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const isBusy =
    createLinkToken.isPending ||
    exchangeToken.isPending ||
    refreshAccounts.isPending ||
    (Boolean(linkToken) && !ready);

  const updateModeLabel = updateModeBankName ?? "this bank";

  return (
    <div className="mx-auto w-full max-w-lg space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {updateModeInstitutionId ? "Manage connection" : "Connect a bank"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {updateModeInstitutionId
            ? "Reopen your bank's login to add or remove authorized accounts — this reuses the existing connection, it will not create a duplicate."
            : "Securely link a bank account with Plaid. In production this opens your bank's real login; in sandbox mode it uses Plaid's test credentials."}
        </p>
      </div>

      {updateModeInstitutionId ? (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          <IconSettings className="size-4 shrink-0" />
          <p>
            Managing <span className="font-medium">{updateModeLabel}</span> connection
          </p>
        </div>
      ) : null}

      <Card className="overflow-hidden rounded-2xl shadow-sm">
        <div className="flex items-center justify-center gap-3 bg-gradient-to-b from-accent/70 to-transparent py-8">
          <div className="flex size-12 items-center justify-center rounded-full bg-card shadow-sm">
            <IconBuildingBank className="size-6 text-primary" />
          </div>
          <div className="flex size-16 items-center justify-center rounded-full bg-primary shadow-md">
            <IconShieldCheck className="size-8 text-primary-foreground" />
          </div>
          <div className="flex size-12 items-center justify-center rounded-full bg-card shadow-sm">
            <IconReceipt2 className="size-6 text-primary" />
          </div>
        </div>
        <CardHeader className="items-center text-center">
          <CardTitle className="text-base">
            {updateModeInstitutionId ? "Add or remove accounts" : "Link your accounts"}
          </CardTitle>
          <CardDescription>
            We only request read access to balances and transactions. Your bank credentials are
            never stored by Finance.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          {updateModeInstitutionId ? null : (
            <div className="flex w-full flex-col items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Add this bank's accounts to
              </p>
              <ToggleGroup
                type="single"
                value={selectedProfile}
                onValueChange={(value) => value && setProfile(value as "personal" | "business")}
                className="gap-0 rounded-full border border-border bg-muted/40 p-0.5"
                aria-label="Profile for this connection"
              >
                <ToggleGroupItem
                  value="personal"
                  size="sm"
                  className={cn(
                    "gap-1.5 rounded-full px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm",
                  )}
                >
                  <IconUser className="size-3.5" />
                  Personal
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="business"
                  size="sm"
                  className={cn(
                    "gap-1.5 rounded-full px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm",
                  )}
                >
                  <IconBriefcase className="size-3.5" />
                  Business
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-center text-[11px] text-muted-foreground">
                You can split individual accounts later on the Accounts page if this login
                holds both personal and business accounts.
              </p>
            </div>
          )}
          <Button onClick={handleConnectClick} disabled={isBusy} className="w-full" size="lg">
            {isBusy
              ? "Connecting..."
              : updateModeInstitutionId
                ? `Manage ${updateModeLabel}`
                : "Connect a bank"}
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <IconLock className="size-3.5" />
            Bank-level 256-bit encryption, powered by Plaid
          </p>

          {error ? (
            <p className="w-full rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {connected ? (
            <div className="flex w-full items-start gap-2 rounded-lg border border-fin-positive/30 bg-fin-positive/10 px-3 py-2 text-sm text-fin-positive">
              <IconCircleCheck className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">Bank connected</p>
                <p className="text-fin-positive/80">
                  Imported {connected.accounts} account{connected.accounts === 1 ? "" : "s"} and{" "}
                  {connected.transactions} transaction{connected.transactions === 1 ? "" : "s"}.
                </p>
                <div className="mt-2 flex gap-3">
                  <Link to="/accounts" className="underline underline-offset-2">
                    View accounts
                  </Link>
                  <Link to="/dashboard" className="underline underline-offset-2">
                    Go to dashboard
                  </Link>
                </div>
              </div>
            </div>
          ) : null}

          {connected?.duplicateOfInstitutionId ? (
            <div className="flex w-full items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">Looks like a duplicate</p>
                <p>
                  This connection overlaps accounts already in{" "}
                  <span className="font-medium">{connected.duplicateOfInstitutionName}</span>.
                </p>
                <Link to="/accounts" className="mt-1 inline-block underline underline-offset-2">
                  Review &amp; merge
                </Link>
              </div>
            </div>
          ) : null}

          {refreshed ? (
            <div className="flex w-full items-start gap-2 rounded-lg border border-fin-positive/30 bg-fin-positive/10 px-3 py-2 text-sm text-fin-positive">
              <IconCircleCheck className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">Connection updated</p>
                <p className="text-fin-positive/80">
                  {refreshed.institutionName} now has {refreshed.accounts} authorized account
                  {refreshed.accounts === 1 ? "" : "s"} ({refreshed.transactions} transaction
                  {refreshed.transactions === 1 ? "" : "s"} synced).
                </p>
                <Link to="/accounts" className="mt-1 inline-block underline underline-offset-2">
                  View accounts
                </Link>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
