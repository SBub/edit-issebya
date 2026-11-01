"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type ExportDownloadResult, exportDownloadUrl, requestExport } from "@/app/export-actions";
import { type ExportRow, exportView } from "@/lib/exports";
import { formatBytes } from "@/lib/reels";
import { capture } from "@/lib/track";

type ButtonState =
  | { state: "idle" }
  | { state: "sending" }
  // The number of jobs the page showed when the render was queued: "Queued"
  // shows until the new job arrives through Realtime.
  | { state: "sent"; jobCount: number }
  | { state: "error"; message: string };

// The download link of one export, as the server action answered it (or
// "expired" once the timeout at expires_at fired).
type Download = { exportId: string } & (
  Exclude<ExportDownloadResult, { state: "signed-out" }> | { state: "expired" }
);

const REFUSED = "The export was not queued. Reload the page and try again.";

const UNTIL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

// Under the preview: the Export button (disabled, with the reason, while a
// render of the current version is queued or running) and the newest export's
// download link, signed for at most the time it has left. One timeout at
// expires_at turns the link into "expired, export again": no polling, no read.
export function ExportPanel({
  reelId,
  blockedReason,
  jobCount,
  latest,
  versionNumber,
}: {
  reelId: string;
  blockedReason: string | null;
  jobCount: number;
  latest: ExportRow | null;
  versionNumber: number | undefined;
}) {
  const router = useRouter();
  const [button, setButton] = useState<ButtonState>({ state: "idle" });
  const [download, setDownload] = useState<Download | null>(null);
  const disabled = blockedReason !== null || button.state === "sending";

  const exportId = latest?.id ?? null;
  const expiresAt = latest?.expires_at ?? null;

  // A server call per export (an external system), and the one timeout that
  // flips the link to expired. Both answer only for the export they were made
  // for, so a newer export's arrival never shows an older link.
  useEffect(() => {
    if (exportId === null || expiresAt === null) return;
    let active = true;
    const view = exportView({ expires_at: expiresAt }, new Date());
    const msLeft = view.state === "ready" ? view.msLeft : 0;
    const timer = setTimeout(() => {
      if (active) setDownload({ exportId, state: "expired" });
    }, msLeft);
    if (view.state === "ready") {
      exportDownloadUrl({ exportId }).then(
        (result) => {
          if (!active) return;
          if (result.state === "signed-out") {
            router.refresh();
            return;
          }
          setDownload((shown) =>
            shown?.exportId === exportId && shown.state === "expired"
              ? shown
              : { exportId, ...result },
          );
        },
        () => {
          if (active) setDownload({ exportId, state: "failed" });
        },
      );
    }
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [exportId, expiresAt, router]);

  async function send() {
    setButton({ state: "sending" });
    try {
      const result = await requestExport({ reelId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "no-version") {
        setButton({ state: "error", message: "No version to export yet." });
        return;
      }
      if (result.status === "refused") {
        setButton({ state: "error", message: REFUSED });
        return;
      }
      setButton({ state: "sent", jobCount });
      capture("studio_export_requested", { reel_id: reelId });
    } catch {
      setButton({ state: "error", message: REFUSED });
    }
  }

  const message =
    blockedReason ??
    (button.state === "sent" && button.jobCount === jobCount
      ? "Queued: waiting for the worker"
      : button.state === "error"
        ? button.message
        : "");

  const shown = latest && download?.exportId === latest.id ? download : null;

  return (
    <section aria-labelledby="export-heading" className="flex flex-col gap-2">
      <h2 id="export-heading" className="text-lg font-semibold">
        Export
      </h2>
      <button
        type="button"
        onClick={send}
        disabled={disabled}
        aria-describedby="export-status"
        className="self-start rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Export
      </button>
      <p
        id="export-status"
        role="status"
        data-testid={blockedReason ? "export-blocked" : "export-status"}
        className={`text-sm ${button.state === "error" && !blockedReason ? "text-red-700" : "text-stone-600"}`}
      >
        {message}
      </p>
      {latest && shown?.state === "ready" && (
        <p className="flex flex-wrap gap-x-2 text-sm">
          <a
            data-testid="export-download"
            href={shown.url}
            download
            onClick={() => capture("studio_export_downloaded", { reel_id: reelId })}
            className="font-medium underline"
          >
            Download version {versionNumber ?? "?"} ({formatBytes(latest.bytes)})
          </a>
          <span className="text-stone-600">
            available until{" "}
            <time dateTime={latest.expires_at}>{UNTIL.format(new Date(latest.expires_at))}</time>
          </span>
        </p>
      )}
      {shown?.state === "expired" && (
        <p data-testid="export-expired" className="text-sm text-stone-600">
          expired, export again
        </p>
      )}
      {shown?.state === "not-configured" && (
        <p className="text-sm text-stone-600">Downloads are not configured here.</p>
      )}
      {shown?.state === "failed" && (
        <p className="text-sm text-red-700">
          The download link was not made. Reload the page to try again.
        </p>
      )}
    </section>
  );
}
