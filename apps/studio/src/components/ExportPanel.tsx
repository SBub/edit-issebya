"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelExport, requestExport } from "@/app/export-actions";
import { DownloadExportButton, downloadExport } from "@/components/DownloadExportButton";
import {
  EDITING_OFF_WHILE_EXPORTING,
  type ExportRef,
  exportBlockedReason,
  exportProgress,
  exportProgressLabel,
  exportRunning,
  liveRenderJobId,
} from "@/lib/exports";
import type { JobRow, StepRow } from "@/lib/jobs";
import type { ReelDetail } from "@/lib/reels";
import { capture } from "@/lib/track";

interface Props {
  reel: Pick<ReelDetail, "id" | "status" | "current_version_id">;
  // The reel's live jobs and steps: a live render is the export in progress,
  // and its render step gives the percent.
  jobs: readonly Pick<JobRow, "id" | "kind" | "status" | "version_id">[];
  steps: readonly Pick<StepRow, "job_id" | "name" | "status" | "progress_percent">[];
  // For "Download vN".
  versions: readonly { id: string; number: number }[];
  // The reel's kept export (its newest one, not yet expired), followed
  // through Realtime: Download shows while there is one.
  latestExport: ExportRef | null;
}

// Export on the reel page, never in the way. The button queues a `render` job
// for the current version; the panel then shows its progress in place
// (`Exporting… 40%`) with a Cancel button, and the owner may leave: only
// Cancel ends an export (`cancel_job`), leaving the page never does. While the
// export runs, editing this reel is off, and the panel says so. The finished
// MP4 is kept for 48 hours: Download shows here (and in the reels list) while
// it is. When the export this page was following finishes with the page still
// open, the file also downloads by itself; anywhere else nothing pops up.
export function ExportPanel({ reel, jobs, steps, versions, latestExport }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const reelId = reel.id;
  // The export this page follows: the one Export queued here, or a live one
  // found on open or started elsewhere. It stays the followed one after it
  // ends, so its result (the download by itself, a failure) shows once.
  const liveId = liveRenderJobId(jobs);
  const [followedId, setFollowedId] = useState<string | null>(liveId);
  if (liveId !== null && liveId !== followedId) setFollowedId(liveId);

  const progress = followedId ? exportProgress(followedId, jobs, steps, latestExport) : null;
  const running = exportRunning(progress);
  const readyId = progress?.kind === "ready" ? progress.exportId : null;
  const blockedReason = exportBlockedReason(reel, jobs);
  const keptVersion = latestExport
    ? (versions.find((version) => version.id === latestExport.version_id)?.number ?? null)
    : null;

  // The followed export finished with this page open: download it at once,
  // one time. Nothing is shown for it but the Download button, which is also
  // the way to the file when the browser blocked a download no click started.
  useEffect(() => {
    if (!readyId) return;
    let active = true;
    void downloadExport(reelId, readyId).then((outcome) => {
      if (!active) return;
      if (outcome === "signed-out") router.refresh();
      else if (outcome === "downloaded") setMessage("Downloaded");
    });
    return () => {
      active = false;
    };
  }, [readyId, reelId, router]);

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
        setFollowedId(sent.jobId);
        return;
      }
      setMessage(sent.status === "blocked" ? sent.reason : "The export was not started. Try again");
    } catch {
      setMessage("The export was not started. Try again");
    } finally {
      setBusy(false);
    }
  }

  // The only way an export ends early. The job's row follows live.
  async function cancel() {
    if (!followedId) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await cancelExport(followedId);
      if (result.status === "signed-out") router.refresh();
      else if (result.status === "failed") setMessage("The export was not cancelled");
    } catch {
      setMessage("The export was not cancelled");
    } finally {
      setBusy(false);
    }
  }

  const percent = progress?.kind === "rendering" ? progress.percent : null;
  const failed = progress?.kind === "failed" && liveId === null;

  return (
    <section
      aria-labelledby="export-heading"
      data-testid="export-panel"
      data-export-state={running ? "exporting" : "idle"}
      className="flex min-w-0 flex-col items-end gap-0.5 text-right"
    >
      <h2 id="export-heading" className="sr-only">
        Export
      </h2>
      {running && progress ? (
        <>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-col items-end gap-1">
              <p
                role="status"
                data-testid="export-status"
                className="text-sm font-medium whitespace-nowrap"
              >
                {exportProgressLabel(progress)}
              </p>
              <div
                role="progressbar"
                aria-label="Export progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                data-testid="export-progress"
                data-percent={percent ?? ""}
                className="h-1.5 w-28 overflow-hidden bg-raised sm:w-40"
              >
                {percent === null ? (
                  <div className="h-full w-1/3 animate-pulse bg-primary/60" />
                ) : (
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                )}
              </div>
            </div>
            <button
              type="button"
              data-testid="export-cancel"
              onClick={() => void cancel()}
              disabled={busy}
              className="border border-line px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          <p
            data-testid="export-editing-off"
            className="max-w-[14rem] text-xs text-muted sm:max-w-[26rem]"
          >
            You can leave this page, the export keeps going. {EDITING_OFF_WHILE_EXPORTING}
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <p
            id="export-reason"
            data-testid="export-blocked-reason"
            className="max-w-[9rem] text-xs text-muted sm:max-w-[18rem]"
          >
            {blockedReason ?? ""}
          </p>
          {latestExport && (
            <DownloadExportButton
              reelId={reelId}
              exportId={latestExport.id}
              variant="button"
              label={keptVersion === null ? "Download" : `Download v${keptVersion}`}
            />
          )}
          <button
            type="button"
            data-testid="export-button"
            onClick={() => void exportNow()}
            disabled={busy || blockedReason !== null}
            aria-describedby="export-reason"
            className="rounded-reel bg-primary px-4 py-1.5 text-sm font-semibold text-on-primary enabled:hover:opacity-90 disabled:opacity-50"
          >
            Export
          </button>
        </div>
      )}
      <p
        aria-live="polite"
        data-testid="export-message"
        className="text-xs break-words empty:hidden"
      >
        {message || (failed ? "The export failed. Try again" : "")}
      </p>
    </section>
  );
}
