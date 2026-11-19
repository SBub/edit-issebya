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
  exportBlockedReason,
  exportProgress,
  exportProgressDetail,
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

// The one box Export and Cancel share: the same size at the same place, so
// pressing Export moves nothing.
const ACTION_BOX = "h-8 w-[4.5rem] flex-none text-sm sm:w-20";

// Export on the reel page, never in the way. The button queues a `render` job
// for the current version; the panel then shows its progress in place
// (`Exporting… 40%`) with a Cancel button, and the owner may leave: only
// Cancel ends an export (`cancel_job`), leaving the page never does.
//
// Nothing in the header moves, ever: the panel is one slot of a fixed size
// (32 px tall, a fixed width per breakpoint), and every state is laid out
// inside it. Cancel takes exactly the Export button's box, the progress line
// and its bar have a fixed width (so no label, `0%` or `100%`, moves them),
// and the notes (why Export is closed, `Downloaded`, a failure) are clipped to
// the slot's two small lines. The words about leaving and about editing being
// off are in the Versions column (`VersionList`), not here. The finished
// MP4 is kept for 48 hours: Download shows here (and in the reels list) while
// it is. When the export this page was following finishes with the page still
// open, the file also downloads by itself; anywhere else nothing pops up.
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
  const reason = running ? "" : (blockedReason ?? "");
  const note = message || (failed ? "The export failed. Try again" : "");
  const downloadNote =
    !running && latestExport && downloadProblem?.exportId === latestExport.id
      ? downloadProblem.text
      : "";

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
      {/* The notes: at most the slot's two lines, the rest is cut (the full
          words are each note's `title`). */}
      <div
        data-testid="export-notes"
        className="flex h-8 min-w-0 flex-1 flex-col justify-center overflow-hidden text-right text-xs leading-4"
      >
        <p
          id="export-reason"
          data-testid="export-blocked-reason"
          title={reason || undefined}
          className="line-clamp-2 text-muted empty:hidden"
        >
          {reason}
        </p>
        <p
          aria-live="polite"
          data-testid="export-message"
          title={note || undefined}
          className="line-clamp-2 empty:hidden"
        >
          {note}
        </p>
        <p
          role="status"
          data-testid="export-download-status"
          title={downloadNote || undefined}
          className="line-clamp-2 text-danger empty:hidden"
        >
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
            className={`${ACTION_BOX} border border-line hover:bg-raised disabled:opacity-50`}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {latestExport && (
            <DownloadExportButton
              reelId={reelId}
              exportId={latestExport.id}
              variant="button"
              label={keptVersion === null ? "Download" : `Download v${keptVersion}`}
              onProblem={(text) => setDownloadProblem({ exportId: latestExport.id, text })}
            />
          )}
          <button
            type="button"
            data-testid="export-button"
            onClick={() => void exportNow()}
            disabled={busy || blockedReason !== null}
            aria-describedby="export-reason"
            className={`${ACTION_BOX} rounded-reel bg-primary font-semibold text-on-primary enabled:hover:opacity-90 disabled:opacity-50`}
          >
            Export
          </button>
        </>
      )}
    </section>
  );
}
