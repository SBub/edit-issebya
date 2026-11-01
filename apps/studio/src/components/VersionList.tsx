"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { goBackTo } from "@/app/version-actions";
import { formatCreatedAt } from "@/lib/reels";
import { type VersionListRow, versionLabel } from "@/lib/versions";

// Every version, newest first; the newest is the current one. Going back
// queues a restore job, which copies the old version into a new one, so
// nothing in the list is ever edited or removed.
export function VersionList({
  reelId,
  versions,
  blockedReason,
}: {
  reelId: string;
  versions: VersionListRow[];
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentId = versions[0]?.id;

  async function goBack(versionId: string) {
    setSending(true);
    setError(null);
    try {
      const result = await goBackTo({ reelId, versionId });
      if (result.status === "signed-out") router.refresh();
      else if (result.status !== "queued")
        setError("Going back was refused. Reload and try again.");
    } catch {
      setError("Going back was refused. Reload and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-labelledby="versions-heading" className="flex flex-col gap-2">
      <h2 id="versions-heading" className="text-lg font-semibold">
        Versions
      </h2>
      {versions.length === 0 ? (
        <p className="text-sm text-stone-600">No version yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white text-sm">
          {versions.map((version) => (
            <li
              key={version.id}
              data-testid="version-row"
              data-version={version.number}
              className="flex flex-col gap-1 px-4 py-3"
            >
              <span className="flex flex-wrap items-baseline gap-3">
                <span className="font-medium">version {version.number}</span>
                <time dateTime={version.created_at} className="text-stone-600">
                  {formatCreatedAt(version.created_at)}
                </time>
                {version.id === currentId && (
                  <span className="rounded bg-stone-200 px-1.5 text-xs">current</span>
                )}
              </span>
              <span data-testid="version-label" className="break-words">
                {versionLabel(version, versions)}
              </span>
              {version.change_summary && (
                <span data-testid="version-summary" className="break-words text-stone-600">
                  {version.change_summary}
                </span>
              )}
              {version.id !== currentId && (
                <button
                  type="button"
                  disabled={blockedReason !== null || sending}
                  title={blockedReason ?? undefined}
                  onClick={() => void goBack(version.id)}
                  className="self-start rounded-md border border-stone-300 px-3 py-1 text-sm disabled:opacity-50"
                >
                  Go back to this
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
