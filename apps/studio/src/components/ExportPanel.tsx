"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelExport, requestExport } from "@/app/export-actions";
import { DownloadExportButton, downloadExport } from "@/components/DownloadExportButton";
import {
  EDITING_OFF_WHILE_EXPORTING,
  EXPORTING_LEAD,
  type ExportRef,
  LEAVE_WHILE_EXPORTING,
  currentVersionExport,
  exportBlockedReason,
  exportProgress,
  exportProgressDetail,
  exportRunning,
  followsCurrentVersion,
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
  // The reel's newest export the page knows of (read from `kept_exports`,
  // then followed through Realtime). Download shows only while its version is
  // the reel's current version (`currentVersionExport`).
  latestExport: ExportRef | null;
}

// The one box Export and Cancel share: the same size at the same place, so
// pressing Export moves nothing.
const ACTION_BOX = "h-8 w-[4.5rem] flex-none text-sm sm:w-20";

// Read out when the file downloaded by itself; never a button's `title`.
const DOWNLOADED = "Downloaded";

// Export on the reel page, never in the way. The button queues a `render` job
// for the current version; the panel then shows its progress in place
// (`Exporting… 40%`) with a Cancel button, and the owner may leave: only
// Cancel ends an export (`cancel_job`), leaving the page never does.
//
// Nothing in the header moves, ever: the panel is one slot of a fixed size
// (32 px tall, a fixed width per breakpoint), and every state is laid out
// inside it. Cancel takes exactly the Export button's box, the progress line
// and its bar have a fixed width (so no label, `0%` or `100%`, moves them).
// The header shows no notes: the only words in the slot are the buttons and
// the one progress line. Why Export is closed, `Downloaded` and what a click
// had to say are read out (`export-notes`, never seen) and are the `title` of
// the button they belong to. A failed export says nothing here at all: the
// failure card over the preview shows it (`ProgressOverlay`). The words about
// leaving and about editing being off are in the Versions column
// (`VersionList`). The finished MP4 is kept for 48 hours and only while its
// version is the current one: Download shows here (and in the reels list)
// while it is. When the export this page was following finishes with the page
// still open, the file also downloads by itself; anywhere else nothing pops up.
export function ExportPanel({ reel, jobs, steps, versions, latestExport }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // What a click on Download had to say, kept with the export it was about: a
  // newer export starts clean.
  const [downloadProblem, setDownloadProblem] = useState<{ exportId: string; text: string } | null>(
    null,
  );
  const reelId = reel.id;
  // The export this page follows: the one Export queued here, or a live one
  // found on open or started elsewhere. It stays the followed one after it
  // ends, so its result (the download by itself, a failure) shows once.
  const liveId = liveRenderJobId(jobs);
  const [followedId, setFollowedId] = useState<string | null>(liveId);
  if (liveId !== null && liveId !== followedId) setFollowedId(liveId);

  // An ended export of a version that is no longer current is not followed.
  const followed = followsCurrentVersion(
    jobs.find((job) => job.id === followedId),
    reel.current_version_id,
  );
  const progress =
    followedId && followed ? exportProgress(followedId, jobs, steps, latestExport) : null;
  const running = exportRunning(progress);
  const readyId = progress?.kind === "ready" ? progress.exportId : null;
  const blockedReason = exportBlockedReason(reel, jobs);
  // The export Download gives: the current version's only.
  const kept = currentVersionExport(latestExport, reel.current_version_id);
  const keptVersion = kept
    ? (versions.find((version) => version.id === kept.version_id)?.number ?? null)
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
      else if (outcome === "downloaded") setMessage(DOWNLOADED);
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
  const reason = running ? "" : (blockedReason ?? "");
  const downloadNote =
    !running && kept && downloadProblem?.exportId === kept.id ? downloadProblem.text : "";

  return (
    // The slot: its size never depends on what it shows, so the title beside
    // it and the page under the header never move.
    <section
      aria-labelledby="export-heading"
      data-testid="export-panel"
      data-export-state={running ? "exporting" : "idle"}
      className="flex h-8 w-[13.5rem] flex-none items-center justify-end gap-2 sm:w-[24rem] sm:gap-3"
    >
      <h2 id="export-heading" className="sr-only">
        Export
      </h2>
      {/* The notes are read out, never seen: no words in the header but the
          buttons' and the progress line's. A failed export has no note; the
          failure card over the preview shows it. */}
      <div data-testid="export-notes" className="sr-only">
        <p id="export-reason" data-testid="export-blocked-reason">
          {reason}
        </p>
        <p aria-live="polite" data-testid="export-message">
          {message}
        </p>
        <p role="status" data-testid="export-download-status">
          {downloadNote}
        </p>
      </div>
      {running && progress ? (
        <>
          {/* A fixed width, the text starting at its left edge, the digits all
              one width: the line and the bar stay where they are from
              `waiting to start` through `0%` to `100%`. On a phone the word
              `Exporting…` is only read out. */}
          <div className="flex w-28 flex-none flex-col gap-0.5 sm:w-48">
            <p
              role="status"
              data-testid="export-status"
              title={`${LEAVE_WHILE_EXPORTING}. ${EDITING_OFF_WHILE_EXPORTING}`}
              className="truncate text-left text-sm leading-5 font-medium tabular-nums"
            >
              <span className="sr-only sm:not-sr-only">{EXPORTING_LEAD} </span>
              {exportProgressDetail(progress)}
            </p>
            <div
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              data-testid="export-progress"
              data-percent={percent ?? ""}
              className="h-1 w-full overflow-hidden bg-raised"
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
            title={message || undefined}
            className={`${ACTION_BOX} border border-line hover:bg-raised disabled:opacity-50`}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {kept && (
            <DownloadExportButton
              reelId={reelId}
              exportId={kept.id}
              variant="button"
              label={keptVersion === null ? "Download" : `Download v${keptVersion}`}
              onProblem={(text) => setDownloadProblem({ exportId: kept.id, text })}
            />
          )}
          <button
            type="button"
            data-testid="export-button"
            onClick={() => void exportNow()}
            disabled={busy || blockedReason !== null}
            aria-describedby="export-reason"
            title={reason || (message === DOWNLOADED ? "" : message) || undefined}
            className={`${ACTION_BOX} rounded-reel bg-primary font-semibold text-on-primary enabled:hover:opacity-90 disabled:opacity-50`}
          >
            Export
          </button>
        </>
      )}
    </section>
  );
}
