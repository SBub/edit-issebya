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
  // The reel's kept export (its newest one, not yet expired).
  exportId: string;
  // `icon`: the reels list's control beside the bin. `button`: the reel
  // page's, with `label` as its text.
  variant: "icon" | "button";
  label?: string;
}

const FAILED = "The file could not be fetched. Try again";
const GONE = "This export is no longer kept. Export again";

// Download of a reel's kept export: in the reels list an icon beside the bin,
// on the reel's page a button. One click downloads the MP4. Nothing else
// happens anywhere: no notice, no dialog. An export that expired meanwhile
// says so and the page refreshes, which takes the control away.
export function DownloadExportButton({ reelId, exportId, variant, label }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ exportId: string; text: string } | null>(null);
  // A message belongs to the export it was about: a newer export starts clean.
  const message = problem?.exportId === exportId ? problem.text : "";

  async function download() {
    setBusy(true);
    setProblem(null);
    const outcome = await downloadExport(reelId, exportId);
    setBusy(false);
    if (outcome === "signed-out") router.refresh();
    else if (outcome === "gone") {
      setProblem({ exportId, text: GONE });
      router.refresh();
    } else if (outcome === "failed") setProblem({ exportId, text: FAILED });
  }

  if (variant === "button") {
    return (
      <span className="flex flex-col items-end gap-0.5">
        <button
          type="button"
          data-testid="export-download"
          onClick={() => void download()}
          disabled={busy}
          title="Download the finished export (kept for 48 hours)"
          className="border border-line px-3 py-1.5 text-sm font-medium hover:bg-raised disabled:opacity-50"
        >
          {label ?? "Download"}
        </button>
        <span
          role="status"
          data-testid="export-download-status"
          className="text-xs break-words text-danger empty:hidden"
        >
          {message}
        </span>
      </span>
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
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5 sm:size-4"
      >
        <path d="M12 4v11" />
        <path d="M7 11l5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    </button>
  );
}
