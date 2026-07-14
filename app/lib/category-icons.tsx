/**
 * Maps `fp_categories.icon` (kebab-case Tabler icon slug, e.g. "shopping-cart")
 * to the matching @tabler/icons-react component. Falls back to a generic dot
 * icon when the slug is missing or unrecognized.
 */
import {
  IconArrowsExchange,
  IconBolt,
  IconBuildingBank,
  IconBuildingStore,
  IconCar,
  IconCash,
  IconCategory,
  IconCoffee,
  IconDeviceLaptop,
  IconDots,
  IconGift,
  IconHeartbeat,
  IconHome,
  IconMovie,
  IconPaw,
  IconPlane,
  IconReceipt,
  IconSchool,
  IconShoppingBag,
  IconShoppingCart,
  IconUserDollar,
  type Icon,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

const ICON_MAP: Record<string, Icon | ComponentType<IconProps>> = {
  bolt: IconBolt,
  coffee: IconCoffee,
  movie: IconMovie,
  "shopping-cart": IconShoppingCart,
  cash: IconCash,
  "building-bank": IconBuildingBank,
  heartbeat: IconHeartbeat,
  dots: IconDots,
  "shopping-bag": IconShoppingBag,
  "device-laptop": IconDeviceLaptop,
  "arrows-exchange": IconArrowsExchange,
  car: IconCar,
  plane: IconPlane,
  "building-store": IconBuildingStore,
  "user-dollar": IconUserDollar,
  receipt: IconReceipt,
  home: IconHome,
  paw: IconPaw,
  gift: IconGift,
  school: IconSchool,
};

export function iconForCategory(slug: string | null | undefined): Icon | ComponentType<IconProps> {
  if (!slug) return IconCategory;
  return ICON_MAP[slug] ?? IconCategory;
}

/** Curated slug list for the category icon picker (/categories, create/edit dialog). */
export const CATEGORY_ICON_CHOICES = Object.keys(ICON_MAP).sort();

/** Fallback color when a category has no `color` set. */
export const DEFAULT_CATEGORY_COLOR = "#94a3b8";
