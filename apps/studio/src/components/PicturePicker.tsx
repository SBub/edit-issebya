"use client";

import { useEffect, useRef, useState } from "react";
import { loadLibrary } from "@/app/photo-actions";
import { CloseButton } from "@/components/CloseButton";
import { pickablePhotos } from "@/lib/owner-edit";
import type { LibraryItem } from "@/lib/photos";

// A photo the picker offers, its large copy and size known.
export type PickedPhoto = LibraryItem & { largeUrl: string; width: number; height: number };

interface Props {
  // What the pick is for: the dialog's heading.
  title: string;
  onPick: (photo: PickedPhoto) => void;
  onClose: () => void;
}

type Loaded =
  { status: "loading" } | { status: "ready"; photos: PickedPhoto[] } | { status: "failed" };

// The editor's picture picker (app_docs/owner-edits.md): every ready photo
// of the owner's library, newest first, as a grid of thumbnails. One click
// picks a photo and closes the dialog; the cross, Escape and the backdrop close
// it with nothing picked. Opens as a modal dialog over the whole page.
export function PicturePicker({ title, onPick, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    dialogRef.current?.showModal();
    let stale = false;
    loadLibrary()
      .then((answer) => {
        if (stale) return;
        setLoaded(
          answer.ok
            ? { status: "ready", photos: pickablePhotos(answer.value) }
            : { status: "failed" },
        );
      })
      .catch(() => {
        if (!stale) setLoaded({ status: "failed" });
      });
    return () => {
      stale = true;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      data-testid="picture-picker"
      aria-labelledby="picture-picker-heading"
      onClose={onClose}
      onClick={(event) => {
        // The backdrop: a click on the dialog itself, outside its content.
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(44rem,calc(100%-2rem))] overflow-y-auto border border-line bg-surface p-5 text-ink backdrop:bg-black/60"
    >
      <div className="mb-4 flex items-center gap-1">
        <h2 id="picture-picker-heading" className="min-w-0 flex-1 truncate text-lg font-semibold">
          {title}
        </h2>
        <CloseButton onClick={() => dialogRef.current?.close()} />
      </div>
      {loaded.status === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading your photos
        </p>
      ) : loaded.status === "failed" ? (
        <p role="alert" className="text-sm text-danger">
          Your photos could not be loaded. Try again
        </p>
      ) : loaded.photos.length === 0 ? (
        <p className="text-sm text-muted">
          Your library has no ready photos yet. Add some in Your library
        </p>
      ) : (
        <ul aria-label="Your photos" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {loaded.photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                data-testid="picture-option"
                data-photo-id={photo.id}
                aria-label={photo.description ?? photo.fileName}
                title={photo.description ?? photo.fileName}
                onClick={() => {
                  onPick(photo);
                  dialogRef.current?.close();
                }}
                className="block aspect-square w-full overflow-hidden border border-line bg-raised hover:outline-2 hover:outline-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL */}
                <img
                  src={photo.thumbnailUrl ?? photo.largeUrl}
                  alt=""
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
