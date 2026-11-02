"use client";

import { useRef } from "react";
import { UploadForm } from "@/components/UploadForm";

// The round + button and the native dialog holding the upload form. The
// dialog stays in the DOM when closed, so an upload in progress is never
// unmounted (Uppy closes on unmount) and the reel page still opens when it
// finishes.
export function UploadDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        aria-label="Upload a reel"
        onClick={() => dialogRef.current?.showModal()}
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] flex size-14 items-center justify-center rounded-full bg-accent text-3xl leading-none font-light text-surface shadow-lg shadow-black/40"
      >
        <span aria-hidden="true">+</span>
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="upload-heading"
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-line bg-panel p-5 text-ink backdrop:bg-black/60"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="upload-heading" className="text-lg font-semibold">
            Upload a reel
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-full border border-line px-3 py-1 text-sm hover:bg-raised"
          >
            Close
          </button>
        </div>
        <UploadForm />
      </dialog>
    </>
  );
}
