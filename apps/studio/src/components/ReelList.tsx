import Link from "next/link";
import { type ReelSummary, formatCreatedAt, reelName } from "@/lib/reels";

// Same zone, so next/link (basePath applies). Links to another zone use <a>.
export function ReelList({ reels }: { reels: ReelSummary[] }) {
  if (reels.length === 0) {
    return (
      <section aria-label="Reels">
        <p className="text-stone-600">No reels yet.</p>
      </section>
    );
  }

  return (
    <ul
      aria-label="Reels"
      className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white"
    >
      {reels.map((reel) => (
        <li key={reel.id}>
          <Link
            href={`/reels/${reel.id}`}
            className="flex flex-col gap-1 px-4 py-3 hover:bg-stone-50 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="font-medium break-all">{reelName(reel)}</span>
            <span className="flex gap-3 text-sm text-stone-600">
              <span data-testid="reel-list-status">{reel.status}</span>
              <time dateTime={reel.created_at}>{formatCreatedAt(reel.created_at)}</time>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
