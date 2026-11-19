"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { loadExport } from "@/app/export-actions";
import { capture } from "@/lib/track";

// Starts a download with no navigation: a programmatic anchor click on the
// signed link (an attachment, so it downloads, never plays).
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

export type DownloadOutcome = "downloaded" | "gone" | "signed-out" | "failed";

// Signs the reel's kept export (a link made at this moment, an attachment
// with the export's file name) and starts the download.
export async function downloadExport(reelId: string, exportId: string): Promise<DownloadOutcome> {
  try {
    const result = await loadExport(reelId, exportId);
    if (result.status === "signed-out") return "signed-out";
    if (result.status === "expired" || result.status === "none") return "gone";
    if (result.status !== "ready") return "failed";
    startDownload(result.url, result.fileName);
    capture("studio_export_downloaded", { reel_id: reelId });
    return "downloaded";
  } catch {
    return "failed";
  }
}

interface Props {
  reelId: string;
  // The reel's kept export (its current version's, not yet expired).
  exportId: string;
  // `icon`: the reels list's control beside the bin. `button`: the reel
  // page's, with `label` as its text from `sm` up; on a phone it shows the
  // icon and `label` is only its name.
  variant: "icon" | "button";
  label?: string;
  // `button` only: what a click had to say (empty when a click starts), for
  // the header's read-out notes. The button shows no words of its own (they
  // are its `title`), so it never changes size.
  onProblem?: (text: string) => void;
}

const FAILED = "The file could not be fetched. Try again";
const GONE = "This export is no longer kept. Export again";

function DownloadIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 4v11" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

// Download of a reel's kept export: in the reels list an icon beside the bin,
// on the reel's page a button of a fixed size (32 px tall like Export; the
// icon alone on a phone, `Download vN` from `sm` up). One click downloads the
// MP4. Nothing else happens anywhere: no notice, no dialog. An export that
// is no longer kept (it expired meanwhile, or a newer version became the
// current one) says so and the page refreshes, which takes the control away.
export function DownloadExportButton({ reelId, exportId, variant, label, onProblem }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ exportId: string; text: string } | null>(null);
  // A message belongs to the export it was about: a newer export starts clean.
  const message = problem?.exportId === exportId ? problem.text : "";

  function say(text: string) {
    setProblem(text ? { exportId, text } : null);
    onProblem?.(text);
  }

  async function download() {
    setBusy(true);
    say("");
    const outcome = await downloadExport(reelId, exportId);
    setBusy(false);
    if (outcome === "signed-out") router.refresh();
    else if (outcome === "gone") {
      say(GONE);
      router.refresh();
    } else if (outcome === "failed") say(FAILED);
  }

  if (variant === "button") {
    const name = label ?? "Download";
    return (
      <button
        type="button"
        data-testid="export-download"
        aria-label={name}
        onClick={() => void download()}
        disabled={busy}
        title={message || "Download the finished export (kept for 48 hours)"}
        data-failed={message ? "true" : undefined}
        className="flex h-8 w-8 flex-none items-center justify-center border border-line text-sm font-medium hover:bg-raised disabled:opacity-50 data-[failed]:text-danger sm:w-32 sm:px-2"
      >
        <DownloadIcon className="size-4 sm:hidden" />
        <span className="hidden min-w-0 truncate sm:block">{name}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={message || "Download the export"}
      title={message || "Download the export (kept for 48 hours)"}
      data-testid="download-export"
      data-failed={message ? "true" : undefined}
      onClick={() => void download()}
      disabled={busy}
      className="flex size-11 items-center justify-center text-ink transition-opacity hover:opacity-70 disabled:opacity-50 data-[failed]:text-danger sm:size-8"
    >
      <DownloadIcon className="size-5 sm:size-4" />
    </button>
  );
}
