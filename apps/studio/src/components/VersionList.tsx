"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestRestore } from "@/app/change-actions";
import { versionOrigin } from "@/lib/change-requests";
import { formatCreatedAt } from "@/lib/reels";
import type { VersionListRow } from "@/lib/versions";

interface Props {
  reelId: string;
  versions: readonly VersionListRow[];
  currentVersionId: string | null;
  // Null when going back is open; otherwise why not, in one line.
  blockedReason: string | null;
}

// Every version of the reel, newest first. Going back queues a `restore`
// job: a new version copying the old one, so going back can be undone too.
export function VersionList({ reelId, versions, currentVersionId, blockedReason }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const byId = new Map(versions.map((version) => [version.id, version]));
  const newestFirst = [...versions].sort((a, b) => b.number - a.number);

  async function goBack(versionId: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await requestRestore({ reelId, versionId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") return;
      setMessage(
        result.status === "failed" ? "Going back did not start. Try again." : result.reason,
      );
    } catch {
      setMessage("Going back did not start. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="versions-heading" className="flex flex-col gap-2">
      <h2 id="versions-heading" className="text-lg font-semibold">
        Versions
      </h2>
      {newestFirst.length === 0 ? (
        <p className="text-sm text-stone-600">No version yet.</p>
      ) : (
        <ol className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white text-sm">
          {newestFirst.map((version) => {
            const current = version.id === currentVersionId;
            return (
              <li
                key={version.id}
                data-testid="version-item"
                data-version-number={version.number}
                data-current={current ? "true" : undefined}
                className="flex flex-col gap-1 px-4 py-3"
              >
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">v{version.number}</span>
                  {current && (
                    <span data-testid="version-current" className="text-xs text-green-700">
                      current
                    </span>
                  )}
                  <time dateTime={version.created_at} className="text-stone-600">
                    {formatCreatedAt(version.created_at)}
                  </time>
                </span>
                <span data-testid="version-origin" className="break-words">
                  {versionOrigin(version, byId)}
                </span>
                {version.change_summary && (
                  <span data-testid="version-summary" className="break-words text-stone-600">
                    {version.change_summary}
                  </span>
                )}
                {!current && (
                  <button
                    type="button"
                    onClick={() => void goBack(version.id)}
                    disabled={busy || blockedReason !== null}
                    aria-describedby="versions-status"
                    className="self-start rounded-md border border-stone-300 px-3 py-1 text-sm disabled:opacity-60"
                  >
                    Go back to this
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p id="versions-status" aria-live="polite" className="min-h-6 text-sm text-stone-600">
        {message || blockedReason || ""}
      </p>
    </section>
  );
}
