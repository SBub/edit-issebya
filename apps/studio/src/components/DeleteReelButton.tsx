"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { deleteReel } from "@/app/reel-actions";

interface Props {
  reelId: string;
  // The reel's name, for the dialog's heading.
  title: string;
}

// The bin in a reel tile's bottom-right corner, always visible, and the
// native confirm dialog it opens. Only Delete deletes (through delete_reel);
// Cancel, Escape and the backdrop close the dialog and change nothing. After a
// delete (or a reel already gone) the list refreshes at once; a failure keeps
// the dialog open with one line saying so.
export function DeleteReelButton({ reelId, title }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const headingId = useId();

  function open() {
    setFailed(false);
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  function confirm() {
    setFailed(false);
    startTransition(async () => {
      const answer = await deleteReel(reelId);
      if (answer.ok || answer.error === "not-found") {
        close();
        router.refresh();
        return;
      }
      setFailed(true);
    });
  }

  return (
    <>
      <button
        type="button"
        aria-label="Delete reel"
        data-testid="delete-reel"
        onClick={open}
        className="flex size-11 items-center justify-center text-ink transition-opacity hover:opacity-70 sm:size-8"
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
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={headingId}
        data-testid="delete-reel-dialog"
        onClick={(event) => {
          // A click on the backdrop lands on the dialog itself.
          if (event.target === event.currentTarget && !pending) close();
        }}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        className="m-auto w-[min(24rem,calc(100%-2rem))] border border-line bg-surface p-5 text-ink backdrop:bg-black/60"
      >
        <h2 id={headingId} className="mb-2 truncate text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm">
          Delete this reel? Its versions and files are removed and cannot be restored.
        </p>
        {failed && (
          <p role="alert" className="mt-3 text-sm text-danger">
            The reel was not deleted. Try again.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="border border-line px-3 py-1 text-sm hover:bg-raised disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending}
            data-testid="confirm-delete-reel"
            className="bg-danger px-3 py-1 text-sm font-medium text-surface disabled:opacity-60"
          >
            Delete
          </button>
        </div>
      </dialog>
    </>
  );
}
