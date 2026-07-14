/**
 * Round avatars for dense finance lists.
 *
 * - MerchantAvatar: colored initial-circle for a merchant/institution/account
 *   name. Deterministic color per name (see lib/finance-format#colorForName)
 *   so the same merchant always gets the same chip color across the app.
 * - CategoryAvatar: the transaction's CATEGORY icon in the category's color
 *   circle — conveys meaning at a glance in dense lists. Falls back to the
 *   merchant initials circle when the row is uncategorized.
 */
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DEFAULT_CATEGORY_COLOR, iconForCategory } from "@/lib/category-icons";
import { colorForName, initials } from "@/lib/finance-format";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "size-7 text-[11px]",
  md: "size-8 text-[11px] sm:size-9 sm:text-xs",
  lg: "size-11 text-sm",
} as const;

const ICON_SIZE_CLASSES = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
} as const;

export function MerchantAvatar({
  name,
  size = "md",
  className,
}: {
  name: string | null | undefined;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const color = colorForName(name);
  return (
    <Avatar className={cn(SIZE_CLASSES[size], className)}>
      <AvatarFallback
        className="font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function CategoryAvatar({
  categoryId,
  icon,
  color,
  fallbackName,
  size = "md",
  className,
}: {
  /** Assigned category id; null/undefined = uncategorized → initials fallback. */
  categoryId: string | null | undefined;
  /** Category icon slug (fp_categories.icon). */
  icon: string | null | undefined;
  /** Category color (fp_categories.color). */
  color: string | null | undefined;
  /** Merchant/name used for the initials fallback when uncategorized. */
  fallbackName: string | null | undefined;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  if (!categoryId) {
    return <MerchantAvatar name={fallbackName} size={size} className={className} />;
  }
  const Icon = iconForCategory(icon);
  const c = color ?? DEFAULT_CATEGORY_COLOR;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-white",
        SIZE_CLASSES[size],
        className,
      )}
      style={{ backgroundColor: c }}
      aria-hidden="true"
    >
      <Icon className={ICON_SIZE_CLASSES[size]} />
    </span>
  );
}
