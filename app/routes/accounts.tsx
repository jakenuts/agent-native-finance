import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBriefcase,
  IconCopy,
  IconDotsVertical,
  IconGitMerge,
  IconHistory,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconUser,
  IconWallet,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { DuplicatesPanel } from "@/components/finance/DuplicatesPanel";
import { MerchantAvatar } from "@/components/finance/MerchantAvatar";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_TITLE } from "@/lib/app-config";
import { formatMoney, formatRelativeTime } from "@/lib/finance-format";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function meta() {
  return [{ title: `Accounts - ${APP_TITLE}` }];
}

function statusDotClass(status: string): string {
  if (status === "connected") return "bg-fin-positive";
  if (status === "error") return "bg-fin-negative";
  return "bg-muted-foreground";
}

interface AccountRow {
  id: string;
  /** Friendly name: the nickname if set, else the institution name. */
  name: string | null;
  /** Raw institution-provided name (shown as secondary text when a nickname is set). */
  officialName: string | null;
  /** The nickname alone, or null when none is set. */
  displayName: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currentBalance: number;
  availableBalance: number | null;
  isoCurrency: string | null;
  isActive: boolean;
  profile: string;
  isManual: boolean;
}

interface InstitutionRow {
  id: string;
  name: string;
  status: string;
  lastSyncedAt: string | null;
  plaidInstitutionId: string | null;
  accounts: AccountRow[];
}

interface MergeCandidate {
  accountId: string;
  accountName: string | null;
  institutionId: string;
  institutionName: string;
  isManual: boolean;
  isPlaidLinked: boolean;
  lastSyncedAt: string | null;
  currentBalanceCents: number | null;
}

interface MergeSuggestion {
  key: string;
  reason: string;
  accountMask: string | null;
  accountType: string | null;
  candidates: MergeCandidate[];
  targetAccountId: string;
  targetAccountName: string | null;
  sourceAccountIds: string[];
  institutionFullyDuplicate?: { institutionId: string; institutionName: string };
}

function isDebt(account: AccountRow): boolean {
  return account.type === "credit" || account.type === "loan";
}

/**
 * Only true checking/savings-style depository accounts have a meaningful
 * "available (spendable) vs current" distinction. CDs are `type: "depository"`
 * in Plaid's taxonomy too, but funds are locked — there's no "available to
 * spend" concept, so exclude that subtype from the available-first display
 * (matches the spec: "asset depository accounts... not credit/loan", scoped
 * to the checking/savings-style meaning of "depository").
 */
function isDepositoryAsset(account: AccountRow): boolean {
  return account.type === "depository" && account.subtype !== "cd" && !isDebt(account);
}

function isRealPlaidInstitution(inst: InstitutionRow): boolean {
  return inst.status !== "manual";
}

type ManualAccountClass = "depository" | "credit" | "loan" | "investment" | "other";

const ACCOUNT_CLASS_OPTIONS: { value: ManualAccountClass; label: string }[] = [
  { value: "depository", label: "Depository (checking/savings)" },
  { value: "credit", label: "Credit card" },
  { value: "loan", label: "Loan" },
  { value: "investment", label: "Investment" },
  { value: "other", label: "Other" },
];

/** True for classes where the balance represents money OWED, not held. */
function isDebtClass(cls: ManualAccountClass): boolean {
  return cls === "credit" || cls === "loan";
}

interface ManualAccountForm {
  institutionName: string;
  accountName: string;
  mask: string;
  accountClass: ManualAccountClass;
  subtype: string;
  balance: string;
  available: string;
  profile: "personal" | "business";
}

const EMPTY_MANUAL_FORM: ManualAccountForm = {
  institutionName: "",
  accountName: "",
  mask: "",
  accountClass: "credit",
  subtype: "",
  balance: "",
  available: "",
  profile: "personal",
};

interface ManualAccountDetailsForm {
  accountName: string;
  mask: string;
  accountClass: ManualAccountClass;
  subtype: string;
}

const EMPTY_DETAILS_FORM: ManualAccountDetailsForm = {
  accountName: "",
  mask: "",
  accountClass: "credit",
  subtype: "",
};

/** Parse a user-typed dollar string ("21,179.24", "$1000") to integer cents, or null if blank/invalid. */
function parseDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/[,$\s]/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function ProfileBadge({ profile }: { profile: string }) {
  const Icon = profile === "business" ? IconBriefcase : IconUser;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 px-1.5 py-0 text-[10px] font-medium capitalize",
        profile === "business"
          ? "border-fin-positive/40 text-fin-positive"
          : "border-muted-foreground/30 text-muted-foreground",
      )}
    >
      <Icon className="size-2.5" />
      {profile}
    </Badge>
  );
}

function HistoryBadge() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-muted-foreground/30 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
    >
      <IconHistory className="size-2.5" />
      history
    </Badge>
  );
}

function ManualBadge() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/40 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400"
    >
      <IconPencil className="size-2.5" />
      manual
    </Badge>
  );
}

/**
 * Depository (checking/savings) accounts LEAD with `availableBalance` (what
 * bank apps show, and what the user actually has to spend) with `current`
 * shown as the small secondary line. Credit/loan accounts keep leading with
 * `current` (the statement/debt balance) — swapping those would be wrong,
 * there's no "available to spend" concept for a debt. History-only manual
 * accounts (no live balances) are unaffected.
 */
function BalanceDisplay({
  account,
  isHistoryOnly,
}: {
  account: AccountRow;
  isHistoryOnly: boolean;
}) {
  const debt = isDebt(account);
  const leadWithAvailable = isDepositoryAsset(account) && account.availableBalance != null;
  const headline = leadWithAvailable ? account.availableBalance! : account.currentBalance;

  return (
    <div className="text-right">
      <Tooltip>
        <TooltipTrigger asChild>
          <p
            className={cn(
              "text-sm font-semibold tabular-nums underline decoration-dotted decoration-muted-foreground/50 underline-offset-2",
              isHistoryOnly ? "text-muted-foreground" : debt ? "text-fin-negative" : "text-foreground",
            )}
          >
            {formatMoney(headline)}
          </p>
        </TooltipTrigger>
        <TooltipContent>
          {leadWithAvailable
            ? `Available (spendable) — current is ${formatMoney(account.currentBalance)}`
            : "Current balance"}
        </TooltipContent>
      </Tooltip>
      {leadWithAvailable ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          current {formatMoney(account.currentBalance)}
        </p>
      ) : isDepositoryAsset(account) && account.availableBalance != null ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatMoney(account.availableBalance)} available
        </p>
      ) : null}
    </div>
  );
}

function AccountLine({
  account,
  institutionLastSyncedAt,
  showDivider,
  onChangeProfile,
  changingProfile,
  onOpenMergePicker,
  onOpenMoveInstitution,
  onFindDuplicates,
  onEditBalance,
  onEditDetails,
  onRename,
  onDeleteManual,
}: {
  account: AccountRow;
  institutionLastSyncedAt: string | null;
  showDivider: boolean;
  onChangeProfile: (accountId: string, profile: "personal" | "business") => void;
  changingProfile: boolean;
  onOpenMergePicker: (account: AccountRow) => void;
  onOpenMoveInstitution: (account: AccountRow) => void;
  onFindDuplicates: (account: AccountRow) => void;
  onEditBalance: (account: AccountRow) => void;
  onEditDetails: (account: AccountRow) => void;
  onRename: (account: AccountRow) => void;
  onDeleteManual: (account: AccountRow) => void;
}) {
  const isHistoryOnly = account.isManual && account.currentBalance === 0;
  // A manual account with a real (non-zero) balance is a hand-tracked account
  // (e.g. a closed-but-in-repayment card) — it gets the edit-balance affordance
  // and a "manual" badge. History-only manual accounts (zero balance, from a
  // CSV import) keep the subtler "history" badge and no balance editing.
  const isManualBalance = account.isManual && !isHistoryOnly;
  return (
    <div>
      {showDivider ? <Separator className="mb-3" /> : null}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              to={`/transactions?accountId=${encodeURIComponent(account.id)}`}
              className={cn(
                "min-w-0 truncate text-sm font-medium hover:underline",
                isHistoryOnly && "text-muted-foreground",
              )}
            >
              {account.name ?? "Account"}
            </Link>
            <span className="flex shrink-0 items-center gap-1.5">
              <ProfileBadge profile={account.profile} />
              {isManualBalance ? <ManualBadge /> : null}
              {isHistoryOnly ? <HistoryBadge /> : null}
            </span>
          </div>
          {/* When a nickname is set, show the real institution name underneath. */}
          {account.displayName && account.officialName && account.officialName !== account.name ? (
            <p className="truncate text-xs text-muted-foreground">{account.officialName}</p>
          ) : null}
          <p className="text-xs capitalize text-muted-foreground">
            {account.type ?? "unknown"}
            {account.subtype ? ` · ${account.subtype}` : ""}
            {account.mask ? ` · ••${account.mask}` : ""}
            {isManualBalance ? (
              <span className="normal-case"> · updated {formatRelativeTime(institutionLastSyncedAt)}</span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BalanceDisplay account={account} isHistoryOnly={isHistoryOnly} />
          {isManualBalance ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => onEditBalance(account)}
                >
                  <IconPencil className="size-4" />
                  <span className="sr-only">Edit balance</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit balance</TooltipContent>
            </Tooltip>
          ) : null}
          {/* Mobile hides this select — the "…" menu carries the profile switch. */}
          <Select
            value={account.profile}
            disabled={changingProfile}
            onValueChange={(value) => onChangeProfile(account.id, value as "personal" | "business")}
          >
            <SelectTrigger
              className="hidden h-7 w-[92px] shrink-0 px-2 text-xs sm:flex"
              aria-label="Change account profile"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">Personal</SelectItem>
              <SelectItem value="business">Business</SelectItem>
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 shrink-0">
                <IconDotsVertical className="size-4" />
                <span className="sr-only">Account actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="sm:hidden"
                disabled={changingProfile}
                onSelect={() =>
                  onChangeProfile(
                    account.id,
                    account.profile === "personal" ? "business" : "personal",
                  )
                }
              >
                <IconArrowRight className="size-4" />
                Move to {account.profile === "personal" ? "Business" : "Personal"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRename(account)}>
                <IconPencil className="size-4" />
                Rename...
              </DropdownMenuItem>
              {account.isManual ? (
                <>
                  <DropdownMenuItem onSelect={() => onEditDetails(account)}>
                    <IconSettings className="size-4" />
                    Edit details...
                  </DropdownMenuItem>
                  {isManualBalance ? (
                    <DropdownMenuItem onSelect={() => onEditBalance(account)}>
                      <IconWallet className="size-4" />
                      Edit balance...
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              <DropdownMenuItem onSelect={() => onOpenMergePicker(account)}>
                <IconGitMerge className="size-4" />
                Merge into...
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenMoveInstitution(account)}>
                <IconArrowRight className="size-4" />
                Move to institution...
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onFindDuplicates(account)}>
                <IconCopy className="size-4" />
                Find duplicates...
              </DropdownMenuItem>
              {account.isManual ? (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => onDeleteManual(account)}
                >
                  <IconTrash className="size-4" />
                  Delete account...
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function InstitutionCard({
  institution,
  onSync,
  syncing,
  onRefreshBalances,
  refreshingBalancesId,
  onChangeProfile,
  changingProfileAccountId,
  onOpenMergePicker,
  onOpenMoveInstitution,
  onManageAtBank,
  onOpenRemoveDialog,
  onFindDuplicates,
  onEditBalance,
  onEditDetails,
  onRename,
  onDeleteManual,
}: {
  institution: InstitutionRow;
  onSync: (id: string) => void;
  syncing: boolean;
  onRefreshBalances: (id: string) => void;
  refreshingBalancesId: string | null;
  onChangeProfile: (accountId: string, profile: "personal" | "business") => void;
  changingProfileAccountId: string | null;
  onOpenMergePicker: (account: AccountRow) => void;
  onOpenMoveInstitution: (account: AccountRow) => void;
  onManageAtBank: (institutionId: string) => void;
  onOpenRemoveDialog: (institution: InstitutionRow) => void;
  onFindDuplicates: (account: AccountRow) => void;
  onEditBalance: (account: AccountRow) => void;
  onEditDetails: (account: AccountRow) => void;
  onRename: (account: AccountRow) => void;
  onDeleteManual: (account: AccountRow) => void;
}) {
  const assets = institution.accounts.filter((a) => !isDebt(a));
  const debts = institution.accounts.filter(isDebt);
  const canManageAtBank = isRealPlaidInstitution(institution);
  const refreshingBalances = refreshingBalancesId === institution.id;

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3">
          <MerchantAvatar name={institution.name} size="lg" />
          <div>
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base">{institution.name}</CardTitle>
              <span
                className={cn("size-2 shrink-0 rounded-full", statusDotClass(institution.status))}
                aria-label={`Status: ${institution.status}`}
                title={institution.status}
              />
              {institution.status === "manual" ? <HistoryBadge /> : null}
            </div>
            <CardDescription className="flex items-center gap-1">
              {institution.status === "manual" ? (
                "Manual / imported — not connected to a live bank"
              ) : (
                <>
                  <IconRefresh className="size-3 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default">
                        Last synced {formatRelativeTime(institution.lastSyncedAt)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {institution.lastSyncedAt
                        ? new Date(institution.lastSyncedAt).toLocaleString()
                        : "Never synced"}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={syncing} onClick={() => onSync(institution.id)}>
            <IconRefresh className={syncing ? "size-4 animate-spin" : "size-4"} />
            Sync
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-8">
                <IconDotsVertical className="size-4" />
                <span className="sr-only">Institution actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onSync(institution.id)}>
                <IconRefresh className="size-4" />
                Sync
              </DropdownMenuItem>
              {canManageAtBank ? (
                <DropdownMenuItem
                  disabled={refreshingBalances}
                  onSelect={() => onRefreshBalances(institution.id)}
                >
                  <IconWallet className="size-4" />
                  Refresh balances
                </DropdownMenuItem>
              ) : null}
              {canManageAtBank ? (
                <DropdownMenuItem onSelect={() => onManageAtBank(institution.id)}>
                  <IconSettings className="size-4" />
                  Manage accounts at bank
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onOpenRemoveDialog(institution)}
              >
                <IconTrash className="size-4" />
                Remove connection...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {institution.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts found for this institution.</p>
        ) : (
          <>
            {assets.length > 0 ? (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Assets
                </p>
                <div className="space-y-3">
                  {assets.map((account, i) => (
                    <AccountLine
                      key={account.id}
                      account={account}
                      institutionLastSyncedAt={institution.lastSyncedAt}
                      showDivider={i > 0}
                      onChangeProfile={onChangeProfile}
                      changingProfile={changingProfileAccountId === account.id}
                      onOpenMergePicker={onOpenMergePicker}
                      onOpenMoveInstitution={onOpenMoveInstitution}
                      onFindDuplicates={onFindDuplicates}
                      onEditBalance={onEditBalance}
                      onEditDetails={onEditDetails}
                      onRename={onRename}
                      onDeleteManual={onDeleteManual}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {debts.length > 0 ? (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Debts
                </p>
                <div className="space-y-3">
                  {debts.map((account, i) => (
                    <AccountLine
                      key={account.id}
                      account={account}
                      institutionLastSyncedAt={institution.lastSyncedAt}
                      showDivider={i > 0}
                      onChangeProfile={onChangeProfile}
                      changingProfile={changingProfileAccountId === account.id}
                      onOpenMergePicker={onOpenMergePicker}
                      onOpenMoveInstitution={onOpenMoveInstitution}
                      onFindDuplicates={onFindDuplicates}
                      onEditBalance={onEditBalance}
                      onEditDetails={onEditDetails}
                      onRename={onRename}
                      onDeleteManual={onDeleteManual}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function suggestionLabel(s: MergeSuggestion): string {
  const target = s.candidates.find((c) => c.accountId === s.targetAccountId);
  const sourceCount = s.sourceAccountIds.length;
  const name = target?.accountName ?? "This account";
  const mask = s.accountMask ? ` ··${s.accountMask}` : "";
  return `${name}${mask} appears in ${s.candidates.length} places`;
}

function NeedsAttentionBanner({
  suggestions,
  onMergeOne,
  onMergeAll,
  merging,
}: {
  suggestions: MergeSuggestion[];
  onMergeOne: (s: MergeSuggestion) => void;
  onMergeAll: () => void;
  merging: boolean;
}) {
  if (suggestions.length === 0) return null;
  return (
    <Card className="rounded-2xl border-amber-500/30 bg-amber-500/5 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <IconAlertTriangle className="size-5 text-amber-600 dark:text-amber-400" />
          <div>
            <CardTitle className="text-base">Needs attention</CardTitle>
            <CardDescription>
              {suggestions.length} likely duplicate account{suggestions.length === 1 ? "" : "s"} found.
            </CardDescription>
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={merging} onClick={onMergeAll}>
          Merge all suggested
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {suggestions.map((s) => {
          const target = s.candidates.find((c) => c.accountId === s.targetAccountId);
          return (
            <div
              key={s.key}
              className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-background/60 px-3 py-2 text-sm"
            >
              <p className="min-w-0 truncate">
                {suggestionLabel(s)} <IconArrowRight className="mx-1 inline size-3.5" />{" "}
                <span className="font-medium">
                  {target?.institutionName} {target?.isPlaidLinked ? "(synced)" : ""}
                </span>
              </p>
              <Button size="sm" disabled={merging} onClick={() => onMergeOne(s)}>
                Merge
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function AccountsRoute() {
  useSetPageTitle("Accounts");

  // Accounts page shows BOTH profiles — this is where mixed-institution
  // logins (e.g. one Example Bank login with a personal and a business
  // account) get split via the per-account profile switcher below.
  const accountsQuery = useActionQuery("list-accounts", { profile: "all" });
  const suggestionsQuery = useActionQuery("get-merge-suggestions", {});
  const syncMutation = useActionMutation("plaid-sync");
  const refreshBalancesMutation = useActionMutation("refresh-balances");
  const setAccountProfile = useActionMutation("set-account-profile");
  const mergeAccountsMutation = useActionMutation("merge-accounts");
  const moveAccountMutation = useActionMutation("move-account-to-institution");
  const removeInstitutionMutation = useActionMutation("remove-institution");
  const createManualAccount = useActionMutation("create-manual-account");
  const setAccountBalance = useActionMutation("set-account-balance");
  const updateManualAccount = useActionMutation("update-manual-account");
  const deleteManualAccount = useActionMutation("delete-manual-account");
  const renameAccount = useActionMutation("rename-account");

  const [mergePickerAccount, setMergePickerAccount] = useState<AccountRow | null>(null);
  const [mergePickerTarget, setMergePickerTarget] = useState<string | null>(null);
  const [movePickerAccount, setMovePickerAccount] = useState<AccountRow | null>(null);
  const [moveTargetInstitution, setMoveTargetInstitution] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstitutionRow | null>(null);
  const [removeMode, setRemoveMode] = useState<"keep" | "delete">("keep");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [duplicatesAccount, setDuplicatesAccount] = useState<AccountRow | null>(null);

  // Add-manual-account dialog state.
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ManualAccountForm>(EMPTY_MANUAL_FORM);
  // Edit-balance dialog state (manual accounts only).
  const [balanceAccount, setBalanceAccount] = useState<AccountRow | null>(null);
  const [balanceCurrent, setBalanceCurrent] = useState("");
  const [balanceAvailable, setBalanceAvailable] = useState("");
  // Edit-details dialog state (manual accounts only).
  const [detailsAccount, setDetailsAccount] = useState<AccountRow | null>(null);
  const [detailsForm, setDetailsForm] = useState<ManualAccountDetailsForm>(EMPTY_DETAILS_FORM);
  // Delete-manual-account confirm state.
  const [deleteManualTarget, setDeleteManualTarget] = useState<AccountRow | null>(null);
  // Rename (nickname) dialog state — works for both Plaid and manual accounts.
  const [renameTarget, setRenameTarget] = useState<AccountRow | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function handleSync(institutionId?: string) {
    syncMutation.mutate(institutionId ? { institutionId } : {}, {
      onSuccess: (result) => {
        toast.success(`Synced ${result.changed} transaction change${result.changed === 1 ? "" : "s"}`);
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : "Sync failed");
      },
    });
  }

  function handleRefreshBalances(institutionId?: string) {
    refreshBalancesMutation.mutate(institutionId ? { institutionId } : {}, {
      onSuccess: (result: {
        results: Array<{ name: string; updated: boolean; accountsUpdated: number; error?: string }>;
      }) => {
        const rows = result.results ?? [];
        const errored = rows.filter((r) => r.error);
        const updated = rows.filter((r) => r.updated);
        if (errored.length > 0) {
          toast.error(
            `Balance refresh failed for ${errored.map((r) => r.name).join(", ")}${
              updated.length > 0 ? ` (${updated.length} updated OK)` : ""
            }`,
          );
        } else if (updated.length === 0) {
          toast.info("No balances changed.");
        } else {
          const accounts = updated.reduce((s, r) => s + r.accountsUpdated, 0);
          toast.success(
            `Refreshed ${accounts} account balance${accounts === 1 ? "" : "s"} across ${updated.length} institution${updated.length === 1 ? "" : "s"}.`,
          );
        }
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : "Balance refresh failed");
      },
    });
  }

  function handleChangeAccountProfile(accountId: string, profile: "personal" | "business") {
    setAccountProfile.mutate(
      { accountId, profile },
      {
        onSuccess: (result) => {
          toast.success(
            `Moved ${result.accountName ?? "account"} to ${profile} (${result.transactionsUpdated} transaction${result.transactionsUpdated === 1 ? "" : "s"} updated).`,
          );
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not change profile.");
        },
      },
    );
  }

  function handleManageAtBank(institutionId: string) {
    window.location.href = `/connect?institutionId=${institutionId}`;
  }

  function handleMergeSuggestion(s: MergeSuggestion, onDone?: () => void) {
    const sources = [...s.sourceAccountIds];
    function next() {
      const fromAccountId = sources.shift();
      if (!fromAccountId) {
        onDone?.();
        return;
      }
      mergeAccountsMutation.mutate(
        { fromAccountId, intoAccountId: s.targetAccountId },
        {
          onSuccess: () => next(),
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Merge failed");
            onDone?.();
          },
        },
      );
    }
    next();
  }

  function handleMergeAllSuggested() {
    const suggestions = suggestionsQuery.data?.suggestions ?? [];
    if (suggestions.length === 0) return;
    const queue = [...suggestions];
    function processNext() {
      const s = queue.shift();
      if (!s) {
        toast.success("Merged all suggested duplicates.");
        return;
      }
      handleMergeSuggestion(s, processNext);
    }
    processNext();
  }

  function handleConfirmMerge() {
    if (!mergePickerAccount || !mergePickerTarget) return;
    mergeAccountsMutation.mutate(
      { fromAccountId: mergePickerAccount.id, intoAccountId: mergePickerTarget },
      {
        onSuccess: (result) => {
          toast.success(
            `Merged into ${result.intoAccountName ?? "target account"} (${result.transactionsMoved} transaction${result.transactionsMoved === 1 ? "" : "s"} moved, ${result.duplicatesRemoved} duplicate${result.duplicatesRemoved === 1 ? "" : "s"} removed).`,
          );
          setMergePickerAccount(null);
          setMergePickerTarget(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Merge failed");
        },
      },
    );
  }

  function handleConfirmMove() {
    if (!movePickerAccount || !moveTargetInstitution) return;
    moveAccountMutation.mutate(
      { accountId: movePickerAccount.id, institutionId: moveTargetInstitution },
      {
        onSuccess: () => {
          toast.success(`Moved ${movePickerAccount.name ?? "account"} to the new institution.`);
          setMovePickerAccount(null);
          setMoveTargetInstitution(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Move failed");
        },
      },
    );
  }

  function handleConfirmRemove() {
    if (!removeTarget) return;
    const keepDataAsManual = removeMode === "keep";
    removeInstitutionMutation.mutate(
      {
        institutionId: removeTarget.id,
        keepDataAsManual,
        removeAtPlaid: true,
        ...(keepDataAsManual ? {} : { confirmDelete: true }),
      },
      {
        onSuccess: (result) => {
          toast.success(
            result.mode === "kept-as-manual"
              ? `${result.institutionName} disconnected — history kept.`
              : `${result.institutionName} and its data were deleted.`,
          );
          setRemoveTarget(null);
          setRemoveMode("keep");
          setDeleteConfirmText("");
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not remove connection.");
        },
      },
    );
  }

  function handleCreateManualAccount() {
    const balanceCents = parseDollarsToCents(addForm.balance);
    if (balanceCents === null) {
      toast.error("Enter a valid current balance.");
      return;
    }
    const availableCents = parseDollarsToCents(addForm.available);
    createManualAccount.mutate(
      {
        institutionName: addForm.institutionName.trim(),
        accountName: addForm.accountName.trim(),
        mask: addForm.mask.trim() || undefined,
        accountClass: addForm.accountClass,
        subtype: addForm.subtype.trim() || undefined,
        currentBalanceCents: balanceCents,
        availableBalanceCents:
          !isDebtClass(addForm.accountClass) && availableCents !== null ? availableCents : undefined,
        profile: addForm.profile,
      },
      {
        onSuccess: (result) => {
          toast.success(`Added ${result.accountName} (${formatMoney(result.balance)}).`);
          if (result.duplicatesRealInstitutionName) {
            toast.info(
              `A connected bank named "${result.institutionName}" already exists — you can merge this account under it later.`,
            );
          }
          setAddOpen(false);
          setAddForm(EMPTY_MANUAL_FORM);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not add account.");
        },
      },
    );
  }

  function handleOpenEditBalance(account: AccountRow) {
    setBalanceAccount(account);
    setBalanceCurrent(String(account.currentBalance));
    setBalanceAvailable(account.availableBalance == null ? "" : String(account.availableBalance));
  }

  function handleConfirmEditBalance() {
    if (!balanceAccount) return;
    const currentCents = parseDollarsToCents(balanceCurrent);
    if (currentCents === null) {
      toast.error("Enter a valid current balance.");
      return;
    }
    const showAvailable = isDepositoryAsset(balanceAccount);
    const availableCents = showAvailable ? parseDollarsToCents(balanceAvailable) : undefined;
    setAccountBalance.mutate(
      {
        accountId: balanceAccount.id,
        currentBalanceCents: currentCents,
        // Only send available for depository accounts; null clears it, undefined leaves it.
        ...(showAvailable ? { availableBalanceCents: availableCents } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(`Updated ${result.accountName ?? "account"} balance to ${formatMoney(result.currentBalance)}.`);
          setBalanceAccount(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not update balance.");
        },
      },
    );
  }

  function handleOpenEditDetails(account: AccountRow) {
    setDetailsAccount(account);
    setDetailsForm({
      accountName: account.name ?? "",
      mask: account.mask ?? "",
      accountClass: (account.type as ManualAccountClass) ?? "other",
      subtype: account.subtype ?? "",
    });
  }

  function handleConfirmEditDetails() {
    if (!detailsAccount) return;
    updateManualAccount.mutate(
      {
        accountId: detailsAccount.id,
        accountName: detailsForm.accountName.trim(),
        mask: detailsForm.mask.trim() || null,
        accountClass: detailsForm.accountClass,
        subtype: detailsForm.subtype.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success("Account details updated.");
          setDetailsAccount(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not update details.");
        },
      },
    );
  }

  function handleConfirmDeleteManual() {
    if (!deleteManualTarget) return;
    deleteManualAccount.mutate(
      { accountId: deleteManualTarget.id, confirmDelete: true },
      {
        onSuccess: (result) => {
          toast.success(
            `Deleted ${result.accountName ?? "account"}${
              result.transactionsDeleted > 0
                ? ` (${result.transactionsDeleted} transaction${result.transactionsDeleted === 1 ? "" : "s"})`
                : ""
            }.`,
          );
          setDeleteManualTarget(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not delete account.");
        },
      },
    );
  }

  function handleOpenRename(account: AccountRow) {
    setRenameTarget(account);
    setRenameValue(account.displayName ?? "");
  }

  function handleConfirmRename() {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    renameAccount.mutate(
      // Empty string clears the nickname (reverts to the institution name).
      { accountId: renameTarget.id, displayName: trimmed === "" ? null : trimmed },
      {
        onSuccess: (result) => {
          toast.success(
            result.displayName
              ? `Renamed to "${result.displayName}".`
              : `Nickname cleared — showing "${result.officialName ?? "account"}".`,
          );
          setRenameTarget(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Could not rename account.");
        },
      },
    );
  }

  const institutions = accountsQuery.data ?? [];
  const suggestions = suggestionsQuery.data?.suggestions ?? [];
  const totals = institutions.reduce(
    (acc, inst) => {
      for (const a of inst.accounts) {
        if (isDebt(a)) acc.debts += a.currentBalance ?? 0;
        else acc.assets += a.currentBalance ?? 0;
      }
      return acc;
    },
    { assets: 0, debts: 0 },
  );

  // Candidates for the merge picker: same account type, not itself.
  const mergeCandidates = mergePickerAccount
    ? institutions.flatMap((inst) =>
        inst.accounts
          .filter((a) => a.id !== mergePickerAccount.id && a.type === mergePickerAccount.type)
          .map((a) => ({ ...a, institutionName: inst.name })),
      )
    : [];

  const deleteConfirmPhrase = removeTarget ? `delete ${removeTarget.name}` : "";
  const canConfirmDelete = deleteConfirmText.trim().toLowerCase() === deleteConfirmPhrase.toLowerCase();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Connected institutions and the accounts under each.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={refreshBalancesMutation.isPending}
            onClick={() => handleRefreshBalances()}
          >
            <IconWallet className={refreshBalancesMutation.isPending ? "size-4 animate-pulse" : "size-4"} />
            Refresh balances
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={syncMutation.isPending}
            onClick={() => handleSync()}
          >
            <IconRefresh className={syncMutation.isPending ? "size-4 animate-spin" : "size-4"} />
            Sync all
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <IconPlus className="size-4" />
            Add account manually
          </Button>
          <Button asChild size="sm">
            <Link to="/connect">Connect a bank</Link>
          </Button>
        </div>
      </div>

      <NeedsAttentionBanner
        suggestions={suggestions}
        onMergeOne={(s) => handleMergeSuggestion(s)}
        onMergeAll={handleMergeAllSuggested}
        merging={mergeAccountsMutation.isPending}
      />

      {!accountsQuery.isLoading && institutions.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-fin-positive/10 p-4 shadow-sm">
            <p className="text-xs text-muted-foreground">Total assets</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-fin-positive">
              {formatMoney(totals.assets)}
            </p>
          </div>
          <div className="rounded-2xl bg-fin-negative/10 p-4 shadow-sm">
            <p className="text-xs text-muted-foreground">Total debts</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-fin-negative">
              {formatMoney(totals.debts)}
            </p>
          </div>
        </div>
      ) : null}

      {accountsQuery.isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : institutions.length === 0 ? (
        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">No institutions connected</CardTitle>
            <CardDescription>
              Connect a bank to start syncing accounts and transactions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link to="/connect">Connect a bank</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {institutions.map((inst) => (
            <InstitutionCard
              key={inst.id}
              institution={inst}
              onSync={handleSync}
              syncing={syncMutation.isPending}
              onRefreshBalances={handleRefreshBalances}
              refreshingBalancesId={
                refreshBalancesMutation.isPending
                  ? (refreshBalancesMutation.variables?.institutionId ?? null)
                  : null
              }
              onChangeProfile={handleChangeAccountProfile}
              changingProfileAccountId={
                setAccountProfile.isPending ? (setAccountProfile.variables?.accountId ?? null) : null
              }
              onOpenMergePicker={setMergePickerAccount}
              onOpenMoveInstitution={setMovePickerAccount}
              onManageAtBank={handleManageAtBank}
              onOpenRemoveDialog={setRemoveTarget}
              onFindDuplicates={setDuplicatesAccount}
              onEditBalance={handleOpenEditBalance}
              onEditDetails={handleOpenEditDetails}
              onRename={handleOpenRename}
              onDeleteManual={setDeleteManualTarget}
            />
          ))}
        </div>
      )}

      {/* Merge picker */}
      <Dialog
        open={mergePickerAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMergePickerAccount(null);
            setMergePickerTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge {mergePickerAccount?.name ?? "account"} into...</DialogTitle>
            <DialogDescription>
              Moves all transactions onto the target account, dedupes overlapping rows, and removes
              this account. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {mergeCandidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other accounts of the same type to merge into.
            </p>
          ) : (
            <RadioGroup value={mergePickerTarget ?? undefined} onValueChange={setMergePickerTarget}>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {mergeCandidates.map((c) => (
                  <label
                    key={c.id}
                    htmlFor={`merge-target-${c.id}`}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm hover:bg-accent/50"
                  >
                    <RadioGroupItem value={c.id} id={`merge-target-${c.id}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{c.name ?? "Account"}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.institutionName}
                        {c.mask ? ` · ••${c.mask}` : ""}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </RadioGroup>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergePickerAccount(null)}>
              Cancel
            </Button>
            <Button
              disabled={!mergePickerTarget || mergeAccountsMutation.isPending}
              onClick={handleConfirmMerge}
            >
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move-to-institution picker */}
      <Dialog
        open={movePickerAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMovePickerAccount(null);
            setMoveTargetInstitution(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {movePickerAccount?.name ?? "account"} to...</DialogTitle>
            <DialogDescription>
              Reparents this account (and its transactions) under a different institution card,
              without merging it into another account.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup value={moveTargetInstitution ?? undefined} onValueChange={setMoveTargetInstitution}>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {institutions.map((inst) => (
                <label
                  key={inst.id}
                  htmlFor={`move-target-${inst.id}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm hover:bg-accent/50"
                >
                  <RadioGroupItem value={inst.id} id={`move-target-${inst.id}`} />
                  <p className="truncate font-medium">{inst.name}</p>
                </label>
              ))}
            </div>
          </RadioGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovePickerAccount(null)}>
              Cancel
            </Button>
            <Button
              disabled={!moveTargetInstitution || moveAccountMutation.isPending}
              onClick={handleConfirmMove}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove connection dialog */}
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemoveMode("keep");
            setDeleteConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconTrash className="size-4" />
              Remove {removeTarget?.name}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left">
                {removeTarget && isRealPlaidInstitution(removeTarget) ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    This frees 1 Plaid connection slot.
                  </p>
                ) : null}
                <RadioGroup value={removeMode} onValueChange={(v) => setRemoveMode(v as "keep" | "delete")}>
                  <label htmlFor="remove-keep" className="flex items-start gap-2 rounded-lg border p-3">
                    <RadioGroupItem value="keep" id="remove-keep" className="mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Keep data as manual</p>
                      <p className="text-xs">
                        Disconnects from Plaid but keeps all transaction history as a manual
                        institution.
                      </p>
                    </div>
                  </label>
                  <label htmlFor="remove-delete" className="flex items-start gap-2 rounded-lg border p-3">
                    <RadioGroupItem value="delete" id="remove-delete" className="mt-0.5" />
                    <div>
                      <p className="font-medium text-destructive">Delete everything</p>
                      <p className="text-xs">
                        Permanently deletes this institution, its accounts, and every transaction.
                        Cannot be undone.
                      </p>
                    </div>
                  </label>
                </RadioGroup>
                {removeMode === "delete" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="delete-confirm" className="text-xs">
                      Type <span className="font-mono">{deleteConfirmPhrase}</span> to confirm
                    </Label>
                    <input
                      id="delete-confirm"
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                      placeholder={deleteConfirmPhrase}
                    />
                  </div>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                removeInstitutionMutation.isPending || (removeMode === "delete" && !canConfirmDelete)
              }
              className={removeMode === "delete" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              onClick={(e) => {
                e.preventDefault();
                handleConfirmRemove();
              }}
            >
              {removeMode === "delete" ? "Delete everything" : "Remove connection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add manual account dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setAddForm(EMPTY_MANUAL_FORM);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add account manually</DialogTitle>
            <DialogDescription>
              For an account a bank connection can&apos;t link — a closed-but-in-repayment card, an
              external loan, or cash. Set its balance here and update it by hand as it changes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-institution">Institution name</Label>
                <Input
                  id="add-institution"
                  placeholder="Example Card"
                  value={addForm.institutionName}
                  onChange={(e) => setAddForm((f) => ({ ...f, institutionName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-name">Account name</Label>
                <Input
                  id="add-name"
                  placeholder="Visa ··4607"
                  value={addForm.accountName}
                  onChange={(e) => setAddForm((f) => ({ ...f, accountName: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-class">Type</Label>
                <Select
                  value={addForm.accountClass}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, accountClass: v as ManualAccountClass }))}
                >
                  <SelectTrigger id="add-class">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_CLASS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-subtype">Subtype (optional)</Label>
                <Input
                  id="add-subtype"
                  placeholder="credit card"
                  value={addForm.subtype}
                  onChange={(e) => setAddForm((f) => ({ ...f, subtype: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-mask">Mask (optional)</Label>
                <Input
                  id="add-mask"
                  placeholder="4607"
                  value={addForm.mask}
                  onChange={(e) => setAddForm((f) => ({ ...f, mask: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-profile">Profile</Label>
                <Select
                  value={addForm.profile}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, profile: v as "personal" | "business" }))}
                >
                  <SelectTrigger id="add-profile">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-balance">Current balance</Label>
              <Input
                id="add-balance"
                inputMode="decimal"
                placeholder="21179.24"
                value={addForm.balance}
                onChange={(e) => setAddForm((f) => ({ ...f, balance: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {isDebtClass(addForm.accountClass)
                  ? "Enter the amount owed (a positive number)."
                  : "Enter the account balance."}
              </p>
            </div>
            {!isDebtClass(addForm.accountClass) && addForm.accountClass === "depository" ? (
              <div className="space-y-1.5">
                <Label htmlFor="add-available">Available balance (optional)</Label>
                <Input
                  id="add-available"
                  inputMode="decimal"
                  placeholder="spendable amount"
                  value={addForm.available}
                  onChange={(e) => setAddForm((f) => ({ ...f, available: e.target.value }))}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                createManualAccount.isPending ||
                !addForm.institutionName.trim() ||
                !addForm.accountName.trim() ||
                addForm.balance.trim() === ""
              }
              onClick={handleCreateManualAccount}
            >
              Add account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit balance dialog (manual accounts only) */}
      <Dialog
        open={balanceAccount !== null}
        onOpenChange={(open) => {
          if (!open) setBalanceAccount(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit balance — {balanceAccount?.name ?? "account"}</DialogTitle>
            <DialogDescription>
              {balanceAccount && isDebt(balanceAccount)
                ? "Update the amount still owed on this account."
                : "Update this account's balance."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bal-current">
                {balanceAccount && isDebt(balanceAccount) ? "Amount owed" : "Current balance"}
              </Label>
              <Input
                id="bal-current"
                inputMode="decimal"
                value={balanceCurrent}
                onChange={(e) => setBalanceCurrent(e.target.value)}
              />
            </div>
            {balanceAccount && isDepositoryAsset(balanceAccount) ? (
              <div className="space-y-1.5">
                <Label htmlFor="bal-available">Available balance (optional)</Label>
                <Input
                  id="bal-available"
                  inputMode="decimal"
                  placeholder="spendable amount"
                  value={balanceAvailable}
                  onChange={(e) => setBalanceAvailable(e.target.value)}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBalanceAccount(null)}>
              Cancel
            </Button>
            <Button disabled={setAccountBalance.isPending} onClick={handleConfirmEditBalance}>
              Save balance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit details dialog (manual accounts only) */}
      <Dialog
        open={detailsAccount !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsAccount(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit details — {detailsAccount?.name ?? "account"}</DialogTitle>
            <DialogDescription>Edit this manual account&apos;s name, type, subtype, and mask.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="det-name">Account name</Label>
              <Input
                id="det-name"
                value={detailsForm.accountName}
                onChange={(e) => setDetailsForm((f) => ({ ...f, accountName: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="det-class">Type</Label>
                <Select
                  value={detailsForm.accountClass}
                  onValueChange={(v) => setDetailsForm((f) => ({ ...f, accountClass: v as ManualAccountClass }))}
                >
                  <SelectTrigger id="det-class">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_CLASS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="det-subtype">Subtype (optional)</Label>
                <Input
                  id="det-subtype"
                  value={detailsForm.subtype}
                  onChange={(e) => setDetailsForm((f) => ({ ...f, subtype: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="det-mask">Mask (optional)</Label>
              <Input
                id="det-mask"
                value={detailsForm.mask}
                onChange={(e) => setDetailsForm((f) => ({ ...f, mask: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsAccount(null)}>
              Cancel
            </Button>
            <Button
              disabled={updateManualAccount.isPending || !detailsForm.accountName.trim()}
              onClick={handleConfirmEditDetails}
            >
              Save details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete manual account confirm */}
      <AlertDialog
        open={deleteManualTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteManualTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconTrash className="size-4" />
              Delete {deleteManualTarget?.name ?? "account"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently deletes this manual account and all of its transactions. If it&apos;s the
              last account under its institution, the institution is removed too. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteManualAccount.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                handleConfirmDeleteManual();
              }}
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename (nickname) dialog — Plaid AND manual accounts */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename account</DialogTitle>
            <DialogDescription>
              Give this account a short, friendly name. This only changes how it&apos;s labeled in{" "}
              {APP_TITLE} — the bank name is kept underneath, and syncing never overwrites it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rename-nickname">Nickname</Label>
              <Input
                id="rename-nickname"
                placeholder={renameTarget?.officialName ?? "e.g. Corp Card 7507"}
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !renameAccount.isPending) handleConfirmRename();
                }}
              />
              {renameTarget?.officialName ? (
                <p className="text-xs text-muted-foreground">
                  Bank name: {renameTarget.officialName}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Leave blank to clear the nickname and show the bank name.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button disabled={renameAccount.isPending} onClick={handleConfirmRename}>
              Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DuplicatesPanel
        open={duplicatesAccount !== null}
        onOpenChange={(open) => !open && setDuplicatesAccount(null)}
        accountId={duplicatesAccount?.id}
      />
    </div>
  );
}
