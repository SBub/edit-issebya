import Link from "next/link";
import type { ReactNode } from "react";

export interface ThumbnailGridItem {
  id: string;
  // Same zone, so next/link (basePath applies). A tile with `href` is a link;
  // one with `onSelect` (and no `href`) is a button.
  href?: string;
  onSelect?: () => void;
  // The visible name under the image; a tile without one shows only its
  // image (photos) and needs `label`.
  title?: string;
  // The tile's accessible name when no title is shown (`aria-label`).
  label?: string;
  // A short-lived signed storage URL, or null for a neutral tile.
  imageUrl: string | null;
  // One short line under the title (for reels, age and size), or none.
  meta?: ReactNode;
  // An optional status line.
  badge?: string;
  // The badge's test id (the reels list keeps `reel-list-status`).
  badgeTestId?: string;
  // A control in the tile's bottom-right corner (the reels list's bin): a
  // sibling of the link or button, never inside it, so using it never opens
  // the tile.
  corner?: ReactNode;
}

// The grid's first tile, before every item: a dashed "+" that adds one (a
// file picker, an upload dialog; the caller decides).
export interface ThumbnailGridAdd {
  // The visible label under the "+", which is also the button's
  // accessible name.
  label: string;
  onAdd: () => void;
  disabled: boolean;
  // `data-ready`: false until the client has hydrated (before that a tap
  // would do nothing); the specs wait for it.
  ready: boolean;
}

interface Props {
  // The list's accessible name.
  label: string;
  items: readonly ThumbnailGridItem[];
  // Shown in place of the list when there is no item.
  empty: ReactNode;
  // Vertical 9:16 tiles (reels) or square ones.
  aspect?: "portrait" | "square";
  // "page": 3 columns on a phone, more as the width allows. "panel": 3 at
  // every width, for a narrow side column.
  columns?: "page" | "panel";
  // An add tile, first in the grid; with no item it is the only tile.
  add?: ThumbnailGridAdd;
  // Each item's thumbnail (and the tile's focus ring) takes the studio's one
  // corner radius (`rounded-reel`); the add tile stays square. Off by
  // default: only the reels list rounds its cards.
  rounded?: boolean;
}

const ASPECTS = { portrait: "aspect-[9/16]", square: "aspect-square" } as const;
const COLUMNS = {
  page: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8",
  panel: "grid-cols-3",
} as const;

// The room a corner control takes beside the title and meta lines, so their
// text never runs under it (size-11 on a phone, size-8 above).
const PAD = "pr-12 sm:pr-9";

const TILE = "group flex flex-col gap-1 text-left focus-visible:outline-offset-4";

const ADD =
  "flex w-full flex-col items-center justify-center gap-1 border-2 border-dashed border-line text-muted transition-colors focus-visible:outline-offset-4 enabled:hover:border-accent enabled:hover:bg-raised enabled:hover:text-accent disabled:opacity-60";

// A grid of thumbnails, each a link or a button, after an optional add tile.
// Nothing reel- or photo-specific: the reels list and the photo library both
// use it.
export function ThumbnailGrid({
  label,
  items,
  empty,
  aspect = "portrait",
  columns = "page",
  add,
  rounded = false,
}: Props) {
  const corner = rounded ? "rounded-reel" : "";
  if (items.length === 0 && !add) {
    return (
      <section aria-label={label} className="text-muted">
        {empty}
      </section>
    );
  }

  const list = (
    <ul aria-label={label} className={`grid gap-2 ${COLUMNS[columns]}`}>
      {add && (
        <li className="min-w-0">
          <button
            type="button"
            disabled={add.disabled}
            data-ready={add.ready ? "true" : "false"}
            data-testid="add-tile"
            onClick={add.onAdd}
            className={`${ADD} ${ASPECTS[aspect]}`}
          >
            <span aria-hidden="true" className="text-3xl leading-none font-light">
              +
            </span>
            <span className="text-xs font-medium">{add.label}</span>
          </button>
        </li>
      )}
      {items.map((item) => {
        const body = (
          <>
            <span
              data-testid="tile-thumbnail"
              className={`relative block ${ASPECTS[aspect]} w-full overflow-hidden border border-line bg-raised ${corner}`}
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL, never a Next image
                <img
                  src={item.imageUrl}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover transition-opacity group-hover:opacity-90"
                />
              ) : (
                <span data-thumbnail="none" className="absolute inset-0 bg-raised" />
              )}
              {item.badge && (
                <span
                  data-testid={item.badgeTestId}
                  className="absolute top-1 left-1 bg-surface/80 px-1.5 py-0.5 text-[10px] font-medium text-ink"
                >
                  {item.badge}
                </span>
              )}
            </span>
            {item.title !== undefined && (
              <span className={`truncate text-xs font-medium text-ink ${item.corner ? PAD : ""}`}>
                {item.title}
              </span>
            )}
            {item.meta !== undefined && (
              <span
                data-testid="tile-meta"
                className={`truncate text-[11px] text-muted ${item.corner ? PAD : ""}`}
              >
                {item.meta}
              </span>
            )}
          </>
        );
        return (
          <li key={item.id} className="relative min-w-0">
            {item.href !== undefined ? (
              <Link href={item.href} aria-label={item.label} className={`${TILE} ${corner}`}>
                {body}
              </Link>
            ) : (
              <button
                type="button"
                onClick={item.onSelect}
                aria-label={item.label}
                className={`${TILE} w-full ${corner}`}
              >
                {body}
              </button>
            )}
            {item.corner && <div className="absolute right-0 bottom-0">{item.corner}</div>}
          </li>
        );
      })}
    </ul>
  );

  if (items.length > 0) return list;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted">{empty}</div>
      {list}
    </div>
  );
}
