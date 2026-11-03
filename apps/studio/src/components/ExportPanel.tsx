"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cancelExport, loadExport, requestExport } from "@/app/export-actions";
import {
  type ExportRef,
  exportBlockedReason,
  exportCancellable,
  exportModalState,
  liveRenderJobId,
} from "@/lib/exports";
import type { JobRow, StepRow } from "@/lib/jobs";
import type { ReelDetail } from "@/lib/reels";
import { capture } from "@/lib/track";

interface Props {
  reel: Pick<ReelDetail, "id" | "status" | "current_version_id">;
  // The reel's live jobs and steps: a render of the current version holds the
  // button, and the modal follows its job's render step.
  jobs: readonly Pick<JobRow, "id" | "kind" | "status" | "version_id">[];
  steps: readonly Pick<StepRow, "job_id" | "name" | "status" | "progress_percent">[];
  // For "Exporting version N".
  versions: readonly { id: string; number: number }[];
  // The newest export, followed through Realtime: the modal's job's export
  // arriving starts the download.
  latestExport: ExportRef | null;
}

// How long "Downloaded" (with the fallback Download link, for a browser that
// blocked the download no click started) shows before the modal closes.
const DOWNLOADED_MS = 4000;

// What the modal does with the file once its export arrived.
type Fetch =
  | { exportId: string; status: "downloaded"; url: string; fileName: string }
  | { exportId: string; status: "failed" };

// Starts a download with no click: a programmatic anchor click on the signed
// link (an attachment, so it downloads, never plays).
function startDownload(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

// Export on the reel page as one action: the button queues a `render` job for
// the current version and opens a modal that follows it live (an
// indeterminate bar until the render step runs, then its percent). When the
// job's export arrives the file downloads by itself, "Downloaded" shows
// briefly and the modal closes. Nothing is kept or offered afterwards:
// exporting again renders again. Closing the modal (Cancel, Escape or the
// close control) while the render is live cancels it (`cancel_job`).
export function ExportPanel({ reel, jobs, steps, versions, latestExport }: Props) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // The render job the modal follows: the one Export queued, or the live one
  // a page opened during an export picks up again.
  const [jobId, setJobId] = useState<string | null>(() => liveRenderJobId(reel, jobs));
  const [fetched, setFetched] = useState<Fetch | null>(null);
  const reelId = reel.id;

  const blockedReason = exportBlockedReason(reel, jobs);
  const disabled = busy || blockedReason !== null;
  const state = jobId ? exportModalState(jobId, jobs, steps, latestExport) : null;
  const job = jobId ? jobs.find((candidate) => candidate.id === jobId) : undefined;
  const versionId = job?.version_id ?? reel.current_version_id;
  const versionNumber = versions.find((version) => version.id === versionId)?.number ?? null;
  const readyId = state?.kind === "ready" ? state.exportId : null;
  const open = jobId !== null && state?.kind !== "cancelled";

  // The modal is a native dialog: shown and closed with the job it follows.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // The job's export arrived: sign it once and download it at once.
  useEffect(() => {
    if (!readyId) return;
    let active = true;
    void loadExport(reelId, readyId).then(
      (result) => {
        if (!active) return;
        if (result.status === "signed-out") {
          router.refresh();
          return;
        }
        if (result.status !== "ready") {
          setFetched({ exportId: readyId, status: "failed" });
          return;
        }
        startDownload(result.url, result.fileName);
        capture("studio_export_downloaded", { reel_id: reelId });
        setFetched({
          exportId: readyId,
          status: "downloaded",
          url: result.url,
          fileName: result.fileName,
        });
      },
      () => {
        if (active) setFetched({ exportId: readyId, status: "failed" });
      },
    );
    return () => {
      active = false;
    };
  }, [readyId, reelId, router]);

  const downloaded = fetched?.status === "downloaded" && fetched.exportId === readyId;
  // "Downloaded" shows briefly, then the modal closes by one timeout.
  useEffect(() => {
    if (!downloaded) return;
    const timer = setTimeout(() => {
      setJobId(null);
      setFetched(null);
    }, DOWNLOADED_MS);
    return () => clearTimeout(timer);
  }, [downloaded]);

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
        setFetched(null);
        setJobId(sent.jobId);
        return;
      }
      setMessage(sent.status === "blocked" ? sent.reason : "The export was not started. Try again");
    } catch {
      setMessage("The export was not started. Try again");
    } finally {
      setBusy(false);
    }
  }

  // Cancel, Escape and the close control all end here: a live render is
  // cancelled, then the modal closes at once (the job's row follows live).
  function close() {
    const following = jobId;
    const live = state !== null && exportCancellable(state);
    setJobId(null);
    setFetched(null);
    if (!following || !live) return;
    void cancelExport(following).then(
      (result) => {
        if (result.status === "signed-out") router.refresh();
        else if (result.status === "failed") setMessage("The export was not cancelled");
      },
      () => setMessage("The export was not cancelled"),
    );
  }

  const title = versionNumber === null ? "Exporting" : `Exporting version ${versionNumber}`;
  const failedFetch = fetched?.status === "failed" && fetched.exportId === readyId;
  let body: ReactNode = null;
  if (state?.kind === "failed") {
    body = (
      <p data-testid="export-modal-status" className="text-sm text-danger">
        The export failed. Try again
      </p>
    );
  } else if (downloaded) {
    body = (
      <>
        <p data-testid="export-modal-status" className="text-sm font-medium">
          Downloaded
        </p>
        <p className="text-xs text-muted">
          Not in your downloads?{" "}
          <a
            data-testid="export-fallback"
            href={fetched.url}
            download={fetched.fileName}
            onClick={() => capture("studio_export_downloaded", { reel_id: reelId })}
            className="font-medium text-accent underline"
          >
            Download
          </a>
        </p>
      </>
    );
  } else if (failedFetch) {
    body = (
      <p data-testid="export-modal-status" className="text-sm text-danger">
        The file could not be fetched. Export again
      </p>
    );
  } else if (state) {
    const percent = state.kind === "rendering" ? state.percent : null;
    const label =
      state.kind === "waiting"
        ? state.label
        : state.kind === "rendering"
          ? `Rendering, ${state.percent}%`
          : "Downloading";
    body = (
      <>
        <div
          role="progressbar"
          aria-label="Export progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          data-testid="export-progress"
          data-percent={percent ?? ""}
          className="h-2 w-full overflow-hidden bg-raised"
        >
          {percent === null ? (
            <div className="h-full w-1/3 animate-pulse bg-accent/60" />
          ) : (
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          )}
        </div>
        <p data-testid="export-modal-status" className="text-sm text-muted">
          {label}
        </p>
      </>
    );
  }

  return (
    <section
      aria-labelledby="export-heading"
      className="flex min-w-0 flex-col items-end gap-0.5 text-right"
    >
      <h2 id="export-heading" className="sr-only">
        Export
      </h2>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <p
          id="export-reason"
          data-testid="export-blocked-reason"
          className="max-w-[9rem] text-xs text-muted sm:max-w-[18rem]"
        >
          {blockedReason ?? ""}
        </p>
        <button
          type="button"
          data-testid="export-button"
          onClick={exportNow}
          disabled={disabled}
          aria-describedby="export-reason"
          className="rounded-reel bg-primary px-4 py-1.5 text-sm font-semibold text-on-primary enabled:hover:opacity-90 disabled:opacity-50"
        >
          Export
        </button>
      </div>
      <p aria-live="polite" className="text-xs break-words empty:hidden">
        {message}
      </p>
      <dialog
        ref={dialogRef}
        data-testid="export-modal"
        aria-labelledby="export-modal-heading"
        onCancel={(event) => {
          // Escape: closed through close(), which cancels a live render.
          event.preventDefault();
          close();
        }}
        className="m-auto w-[min(24rem,calc(100%-2rem))] border border-line bg-surface p-5 text-left text-ink backdrop:bg-black/60"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="export-modal-heading" className="text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            data-testid="export-modal-close"
            onClick={close}
            className="flex size-8 items-center justify-center border border-line text-base hover:bg-raised"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div aria-live="polite" className="flex flex-col gap-2">
          {body}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="export-cancel"
            onClick={close}
            className="border border-line px-3 py-1 text-sm hover:bg-raised"
          >
            {state && exportCancellable(state) ? "Cancel" : "Close"}
          </button>
        </div>
      </dialog>
    </section>
  );
}
