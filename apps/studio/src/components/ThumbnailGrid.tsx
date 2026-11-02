import Link from "next/link";
import type { ReactNode } from "react";

export interface ThumbnailGridItem {
  id: string;
  // Same zone, so next/link (basePath applies).
  href: string;
  title: string;
  // A short-lived signed storage URL, or null for a neutral tile.
  imageUrl: string | null;
  // One short line under the title (for reels, age and size).
  meta: ReactNode;
  // An optional status line.
  badge?: string;
  // The badge's test id (the reels list keeps `reel-list-status`).
  badgeTestId?: string;
}

interface Props {
  // The list's accessible name.
  label: string;
  items: readonly ThumbnailGridItem[];
  // Shown in place of the list when there is no item.
  empty: ReactNode;
}

// A grid of vertical (9:16) thumbnails: 3 columns on a phone, more as the
// width allows. Nothing reel-specific: the photo library reuses it.
export function ThumbnailGrid({ label, items, empty }: Props) {
  if (items.length === 0) {
    return (
      <section aria-label={label} className="text-muted">
        {empty}
      </section>
    );
  }

  return (
    <ul
      aria-label={label}
      className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8"
    >
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <Link
            href={item.href}
            className="group flex flex-col gap-1 rounded-lg focus-visible:outline-offset-4"
          >
            <span className="relative block aspect-[9/16] overflow-hidden rounded-lg border border-line bg-raised">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL, never a Next image
                <img
                  src={item.imageUrl}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover transition-opacity group-hover:opacity-90"
                />
              ) : (
                <span data-thumbnail="none" className="absolute inset-0 bg-panel" />
              )}
              {item.badge && (
                <span
                  data-testid={item.badgeTestId}
                  className="absolute top-1 left-1 rounded-full bg-surface/80 px-1.5 py-0.5 text-[10px] font-medium text-ink"
                >
                  {item.badge}
                </span>
              )}
            </span>
            <span className="truncate text-xs font-medium text-ink">{item.title}</span>
            <span data-testid="tile-meta" className="truncate text-[11px] text-muted">
              {item.meta}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
