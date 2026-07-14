/**
 * Categorization engine: system category definitions, the Plaid PFC →
 * category mapping, and the rule/PFC resolution logic used by sync and the
 * apply-rules action.
 *
 * Precedence (see resolveCategory): category_locked keeps the current value >
 * first matching enabled rule (ascending priority) > Plaid PFC mapping > null.
 */

/** One of the three analytic groups a category can belong to. */
export type CategoryGroup = "expenses" | "earnings" | "ignored";

export interface SystemCategorySeed {
  id: string;
  name: string;
  group: CategoryGroup;
  icon: string;
  color: string;
}

/**
 * System categories seeded by migration (see server/plugins/db.ts). Ids are
 * deterministic so the seed is idempotent across restarts and databases.
 */
export const SYSTEM_CATEGORIES: SystemCategorySeed[] = [
  { id: "cat_groceries", name: "Groceries", group: "expenses", icon: "shopping-cart", color: "#4ade80" },
  { id: "cat_dining", name: "Dining", group: "expenses", icon: "coffee", color: "#f97316" },
  { id: "cat_transport", name: "Transport", group: "expenses", icon: "car", color: "#60a5fa" },
  { id: "cat_shopping", name: "Shopping", group: "expenses", icon: "shopping-bag", color: "#c084fc" },
  { id: "cat_entertainment", name: "Entertainment", group: "expenses", icon: "movie", color: "#f472b6" },
  { id: "cat_bills", name: "Bills & Utilities", group: "expenses", icon: "bolt", color: "#facc15" },
  { id: "cat_medical", name: "Medical", group: "expenses", icon: "heartbeat", color: "#ef4444" },
  { id: "cat_travel", name: "Travel", group: "expenses", icon: "plane", color: "#2dd4bf" },
  { id: "cat_software", name: "Software & Tech", group: "expenses", icon: "device-laptop", color: "#818cf8" },
  { id: "cat_income", name: "Income", group: "earnings", icon: "cash", color: "#22c55e" },
  { id: "cat_transfers", name: "Transfers", group: "ignored", icon: "arrows-exchange", color: "#94a3b8" },
  { id: "cat_loan_payments", name: "Loan Payments", group: "ignored", icon: "building-bank", color: "#94a3b8" },
  { id: "cat_other", name: "Other", group: "expenses", icon: "dots", color: "#a8a29e" },
];

/**
 * System categories for the 'business' profile, seeded by migration v22
 * (see server/plugins/db.ts). Distinct deterministic ids from the personal
 * set so both profiles' system categories coexist without collision.
 */
export const SYSTEM_CATEGORIES_BUSINESS: SystemCategorySeed[] = [
  { id: "cat_biz_revenue", name: "Revenue", group: "earnings", icon: "cash", color: "#22c55e" },
  { id: "cat_biz_opex", name: "Operating Expenses", group: "expenses", icon: "building-store", color: "#f97316" },
  { id: "cat_biz_software", name: "Software & Infrastructure", group: "expenses", icon: "device-laptop", color: "#818cf8" },
  { id: "cat_biz_contractor", name: "Contractor", group: "expenses", icon: "user-dollar", color: "#c084fc" },
  { id: "cat_biz_fees", name: "Financial & Fees", group: "expenses", icon: "receipt", color: "#facc15" },
  { id: "cat_biz_taxes", name: "Taxes", group: "expenses", icon: "building-bank", color: "#ef4444" },
  { id: "cat_biz_owner_draw", name: "Owner Draw", group: "ignored", icon: "arrows-exchange", color: "#94a3b8" },
  { id: "cat_biz_other", name: "Other Business", group: "expenses", icon: "dots", color: "#a8a29e" },
];

/**
 * Plaid personal-finance-category PRIMARY code → system category name.
 * Detailed overrides (below) win over the primary mapping.
 */
export const PFC_PRIMARY_TO_CATEGORY: Record<string, string> = {
  FOOD_AND_DRINK: "Dining",
  GENERAL_MERCHANDISE: "Shopping",
  ENTERTAINMENT: "Entertainment",
  RENT_AND_UTILITIES: "Bills & Utilities",
  BANK_FEES: "Bills & Utilities",
  MEDICAL: "Medical",
  TRAVEL: "Travel",
  TRANSPORTATION: "Transport",
  INCOME: "Income",
  TRANSFER_IN: "Transfers",
  TRANSFER_OUT: "Transfers",
  LOAN_PAYMENTS: "Loan Payments",
  PERSONAL_CARE: "Other",
  GENERAL_SERVICES: "Other",
  HOME_IMPROVEMENT: "Other",
  GOVERNMENT_AND_NON_PROFIT: "Other",
};

/** Plaid PFC DETAILED code → category name (wins over the primary mapping). */
export const PFC_DETAILED_TO_CATEGORY: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: "Groceries",
  GENERAL_SERVICES_INSURANCE: "Bills & Utilities",
  GENERAL_MERCHANDISE_ELECTRONICS: "Software & Tech",
};

/** Minimal transaction shape the resolver needs. */
export interface CategorizableTxn {
  name: string | null;
  merchantName: string | null;
  accountId: string | null;
  amountCents: number;
  pfcPrimary?: string | null;
  pfcDetailed?: string | null;
  categoryId?: string | null;
  categoryLocked?: boolean | null;
}

/** Minimal rule shape (matches fp_rules rows). */
export interface CategorizationRule {
  id: string;
  priority: number;
  isEnabled: boolean;
  matchName: string | null;
  matchNameMode: string | null; // 'contains' | 'exact' | 'regex'
  /** Optional contains-none term: name/merchant must NOT contain it (case-insensitive). */
  matchNameExclude?: string | null;
  matchAccountId: string | null;
  matchMinCents: number | null;
  matchMaxCents: number | null;
  setCategoryId: string | null;
  setMerchantName: string | null;
}

/**
 * Compile a regex match pattern case-insensitively. Returns null (never
 * matches) instead of throwing when the pattern is invalid — callers that
 * need to surface this to the user should use `isValidRulePattern` first.
 */
export function compileRuleRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** True when a regex match-name pattern compiles. Used to validate at create/update time. */
export function isValidRulePattern(pattern: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** Minimal category shape (matches fp_categories rows). */
export interface CategoryRef {
  id: string;
  name: string;
  categoryGroup: string;
}

/**
 * True when every configured match_* condition on the rule passes.
 * ORDER: include-match (matchName/matchNameMode) AND NOT exclude
 * (matchNameExclude) AND account AND amount bounds.
 */
export function matchesRule(txn: CategorizableTxn, rule: CategorizationRule): boolean {
  if (rule.matchName) {
    const haystacks = [txn.name, txn.merchantName]
      .filter((s): s is string => Boolean(s))
      .map((s) => s.toLowerCase());
    const mode = rule.matchNameMode === "exact" || rule.matchNameMode === "regex" ? rule.matchNameMode : "contains";

    let hit: boolean;
    if (mode === "regex") {
      const re = compileRuleRegex(rule.matchName);
      // An invalid pattern never matches (surfaced as `invalid` in list-rules).
      hit = re ? haystacks.some((h) => re.test(h)) : false;
    } else {
      const needle = rule.matchName.toLowerCase();
      hit = mode === "exact" ? haystacks.some((h) => h === needle) : haystacks.some((h) => h.includes(needle));
    }
    if (!hit) return false;

    // Exclude term: name/merchant must NOT contain it (case-insensitive).
    if (rule.matchNameExclude && rule.matchNameExclude.trim()) {
      const excludeNeedle = rule.matchNameExclude.toLowerCase();
      const excluded = haystacks.some((h) => h.includes(excludeNeedle));
      if (excluded) return false;
    }
  }
  if (rule.matchAccountId && txn.accountId !== rule.matchAccountId) return false;
  if (rule.matchMinCents != null && txn.amountCents < rule.matchMinCents) return false;
  if (rule.matchMaxCents != null && txn.amountCents > rule.matchMaxCents) return false;
  // A rule with no conditions at all matches nothing (safety guard).
  if (
    !rule.matchName &&
    !rule.matchAccountId &&
    rule.matchMinCents == null &&
    rule.matchMaxCents == null
  ) {
    return false;
  }
  return true;
}

export interface ResolvedCategory {
  categoryId: string | null;
  /** Merchant rename requested by the winning rule, if any. */
  setMerchantName: string | null;
  /** Which layer decided: 'locked' | 'rule' | 'pfc' | 'none'. */
  source: "locked" | "rule" | "pfc" | "none";
  ruleId?: string;
}

/** Look up a category id by its PFC mapping (detailed first, then primary). */
export function categoryIdForPfc(
  pfcPrimary: string | null,
  pfcDetailed: string | null,
  categories: CategoryRef[],
): string | null {
  const name =
    (pfcDetailed ? PFC_DETAILED_TO_CATEGORY[pfcDetailed] : undefined) ??
    (pfcPrimary ? PFC_PRIMARY_TO_CATEGORY[pfcPrimary] : undefined);
  if (!name) return null;
  const found = categories.find((c) => c.name === name);
  return found ? found.id : null;
}

/**
 * Resolve the category for a transaction.
 * Precedence: locked (keep current) > first matching enabled rule by
 * ascending priority > Plaid PFC mapping > null.
 */
export function resolveCategory(
  txn: CategorizableTxn,
  rulesList: CategorizationRule[],
  categories: CategoryRef[],
): ResolvedCategory {
  if (txn.categoryLocked) {
    return { categoryId: txn.categoryId ?? null, setMerchantName: null, source: "locked" };
  }

  const enabled = rulesList
    .filter((r) => r.isEnabled)
    .sort((a, b) => a.priority - b.priority);
  for (const rule of enabled) {
    if (!matchesRule(txn, rule)) continue;
    if (rule.setCategoryId || rule.setMerchantName) {
      return {
        categoryId: rule.setCategoryId ?? txn.categoryId ?? null,
        setMerchantName: rule.setMerchantName ?? null,
        source: "rule",
        ruleId: rule.id,
      };
    }
  }

  const pfcId = categoryIdForPfc(txn.pfcPrimary ?? null, txn.pfcDetailed ?? null, categories);
  if (pfcId) return { categoryId: pfcId, setMerchantName: null, source: "pfc" };
  return { categoryId: null, setMerchantName: null, source: "none" };
}
