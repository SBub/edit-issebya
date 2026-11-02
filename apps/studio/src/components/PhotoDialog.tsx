"use client";

import { type RefObject, useState } from "react";
import { type LibraryItem, formatDimensions } from "@/lib/photos";
import { formatBytes } from "@/lib/reels";

interface Props {
  dialogRef: RefObject<HTMLDialogElement | null>;
  // The open photo, kept live by the library (null once it is gone).
  photo: LibraryItem | null;
  // Resolves with an error line, or null once the photo is deleted.
  onDelete: (photoId: string) => Promise<string | null>;
}

// One photo, large, with what the worker found in it: the description and the
// tags. A photo not described yet shows its status and no image. Delete asks
// once more inside the dialog before it removes the photo and its files.
export function PhotoDialog({ dialogRef, photo, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function close() {
    dialogRef.current?.close();
  }

  async function remove() {
    if (!photo) return;
    setBusy(true);
    setMessage("");
    const error = await onDelete(photo.id);
    setBusy(false);
    if (error) {
      setMessage(error);
      return;
    }
    close();
  }

  const dimensions = photo ? formatDimensions(photo.width, photo.height) : null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="photo-heading"
      onClose={() => {
        setConfirming(false);
        setMessage("");
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100%-2rem))] overflow-y-auto rounded-xl border border-line bg-panel p-5 text-ink backdrop:bg-black/60"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="photo-heading" className="min-w-0 truncate text-lg font-semibold">
          {photo?.fileName ?? "Photo"}
        </h2>
        <button
          type="button"
          onClick={close}
          className="flex-none rounded-full border border-line px-3 py-1 text-sm hover:bg-raised"
        >
          Close
        </button>
      </div>
      {photo && (
        <div className="flex flex-col gap-3">
          {photo.largeUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL, never a Next image
            <img
              src={photo.largeUrl}
              alt={photo.description ?? ""}
              className="max-h-[60dvh] w-full rounded-lg bg-raised object-contain"
            />
          ) : (
            <p
              data-testid="photo-dialog-status"
              className="rounded-lg border border-line bg-raised px-3 py-6 text-center text-sm text-muted"
            >
              {photo.status}
            </p>
          )}
          <p className="text-xs text-muted">
            {formatBytes(photo.bytes)}
            {dimensions ? ` · ${dimensions}` : ""}
          </p>
          {photo.description && (
            <p data-testid="photo-description" className="text-sm">
              {photo.description}
            </p>
          )}
          {photo.tags.length > 0 && (
            <ul aria-label="Tags" className="flex flex-wrap gap-1">
              {photo.tags.map((tag) => (
                <li
                  key={tag}
                  data-testid="photo-tag"
                  className="rounded-full border border-line px-2 py-0.5 text-xs"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-end gap-2">
            {confirming ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  className="rounded-full border border-line px-3 py-1 text-sm hover:bg-raised"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove()}
                  className="rounded-full bg-danger px-3 py-1 text-sm font-medium text-surface disabled:opacity-60"
                >
                  Yes, delete
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-full border border-danger/60 px-3 py-1 text-sm text-danger hover:bg-danger/10"
              >
                Delete photo
              </button>
            )}
          </div>
          {message && (
            <p role="alert" className="text-sm text-danger">
              {message}
            </p>
          )}
        </div>
      )}
    </dialog>
  );
}
