/** Shared money/category formatting helpers for the Finance UI. */

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Format a dollar amount (already divided from cents) as USD, e.g. $1,234.56. */
export function formatMoney(dollars: number): string {
  return usd.format(dollars);
}

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact USD for tight spaces like chart axis ticks, e.g. $80K, $1.2M. */
export function formatMoneyCompact(dollars: number): string {
  return usdCompact.format(dollars);
}

/** Format a signed spend amount: positive = spend, negative = income. */
export function formatSignedMoney(dollars: number): string {
  const abs = usd.format(Math.abs(dollars));
  return dollars < 0 ? `+${abs}` : `-${abs}`;
}

/** Turn a Plaid personal-finance-category primary code into a readable label. */
export function formatCategory(pfcPrimary: string | null | undefined): string {
  if (!pfcPrimary) return "Uncategorized";
  return pfcPrimary
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** YYYY-MM for the current month. */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Shift a YYYY-MM string by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [yearStr, monStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monStr); // 1-12
  const total = year * 12 + (mon - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Format "2026-07" as "July 2026". */
export function formatMonthLabel(month: string): string {
  const [yearStr, monStr] = month.split("-");
  const date = new Date(Number(yearStr), Number(monStr) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Format a YYYY-MM-DD date string as a short display date. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return "";
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Format a YYYY-MM-DD date string as a group header, e.g. "Jul 4, 2026". */
export function formatDateHeading(date: string | null | undefined): string {
  return formatDate(date);
}

/** Format an ISO timestamp as a short relative time, e.g. "2m ago", "3h ago", "5d ago". */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/** 1-2 uppercase letters to show inside a merchant/institution avatar circle. */
export function initials(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_PALETTE = [
  "#4f46e5", // indigo
  "#0891b2", // cyan
  "#db2777", // pink
  "#16a34a", // green
  "#ea580c", // orange
  "#7c3aed", // violet
  "#0d9488", // teal
  "#ca8a04", // amber
  "#dc2626", // red
  "#2563eb", // blue
];

/** Deterministic color for a name, used for merchant/institution avatar chips. */
export function colorForName(name: string | null | undefined): string {
  const str = (name ?? "?").trim() || "?";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx];
}
