"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type LatestExportResult, loadLatestExport, requestExport } from "@/app/export-actions";
import { exportBlockedReason } from "@/lib/exports";
import type { JobRow } from "@/lib/jobs";
import { type ReelDetail, formatBytes, formatCreatedAt } from "@/lib/reels";
import { capture } from "@/lib/track";

interface Props {
  reel: Pick<ReelDetail, "id" | "status" | "current_version_id">;
  // The reel's live jobs: a render of the current version holds the button.
  jobs: readonly Pick<JobRow, "kind" | "status" | "version_id">[];
  // The newest export's id, followed through Realtime: a new one reloads the link.
  latestExportId: string | null;
}

// Export on the reel page: the button queues a `render` job for the current
// version; the newest export shows its download link, signed for no longer
// than the time left, until it expires and reads `expired, export again`.
export function ExportPanel({ reel, jobs, latestExportId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<LatestExportResult | null>(null);
  // The id of the export whose link has run out while the page is open.
  const [expiredId, setExpiredId] = useState<string | null>(null);
  const reelId = reel.id;

  // Reads (and signs) the newest export on mount and whenever a new one is
  // recorded; a stale answer never replaces a newer one.
  useEffect(() => {
    let active = true;
    void loadLatestExport(reelId).then(
      (loaded) => {
        if (active) setResult(loaded);
      },
      () => {
        if (active) setResult({ status: "failed" });
      },
    );
    return () => {
      active = false;
    };
  }, [reelId, latestExportId]);

  const readyExpiresAt = result?.status === "ready" ? result.expiresAt : null;
  const readyId = result?.status === "ready" ? result.exportId : null;

  // One timer to the link's expiry: the view turns to expired with no network
  // and no polling.
  useEffect(() => {
    if (!readyExpiresAt || !readyId) return;
    const timer = setTimeout(
      () => setExpiredId(readyId),
      Math.max(0, Date.parse(readyExpiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [readyExpiresAt, readyId]);

  const blockedReason = exportBlockedReason(reel, jobs);
  const disabled = busy || blockedReason !== null;

  async function exportNow() {
    setBusy(true);
    setMessage("");
    try {
      const sent = await requestExport(reelId);
      if (sent.status === "signed-out") {
        router.refresh();
        return;
      }
      if (sent.status === "queued") {
        capture("studio_export_requested", { reel_id: reelId });
        return;
      }
      setMessage(
        sent.status === "blocked" ? sent.reason : "The export was not started. Try again.",
      );
    } catch {
      setMessage("The export was not started. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const expired =
    result?.status === "expired" || (result?.status === "ready" && expiredId === result.exportId);

  return (
    <section aria-labelledby="export-heading" className="flex flex-col gap-2">
      <h2 id="export-heading" className="text-lg font-semibold">
        Export
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="export-button"
          onClick={exportNow}
          disabled={disabled}
          aria-describedby="export-reason"
          className="rounded-md bg-stone-900 px-4 py-2 text-base font-medium text-white disabled:opacity-60"
        >
          Export
        </button>
        <p
          id="export-reason"
          data-testid="export-blocked-reason"
          className="text-sm text-stone-600"
        >
          {blockedReason ?? ""}
        </p>
      </div>
      <p aria-live="polite" className="min-h-6 text-sm break-words">
        {message}
      </p>
      {expired ? (
        <p data-testid="export-expired" className="text-sm text-stone-600">
          expired, export again
        </p>
      ) : (
        result?.status === "ready" && (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <a
              data-testid="export-link"
              href={result.url}
              download={result.fileName}
              onClick={() => capture("studio_export_downloaded", { reel_id: reelId })}
              className="font-medium underline"
            >
              Download version {result.versionNumber} ({formatBytes(result.bytes)})
            </a>
            <span className="text-stone-600">
              expires <time dateTime={result.expiresAt}>{formatCreatedAt(result.expiresAt)}</time>
            </span>
          </p>
        )
      )}
    </section>
  );
}
