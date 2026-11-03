"use client";

import { type ChangeEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { deletePhoto, finishPhotoUpload, loadLibrary, startPhotoUpload } from "@/app/photo-actions";
import { DROP_ZONE_OVER, DropHint, useFileDrop } from "@/components/FileDrop";
import { PhotoDialog } from "@/components/PhotoDialog";
import { type ThumbnailGridItem, ThumbnailGrid } from "@/components/ThumbnailGrid";
import { TOO_MANY_FILES, UPLOAD_RUNNING, decideDrop } from "@/lib/file-drop";
import type { PhotoError } from "@/lib/photo-server";
import { type LibraryItem, PHOTO_ACCEPT, photoBadge, photoTileLabel } from "@/lib/photos";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

const noSubscribe = () => () => {};

const ERRORS: Record<PhotoError, string> = {
  "signed-out": "You are signed out. Sign in again to upload.",
  unavailable: "Photo uploads are not available right now.",
  name: "That file name cannot be used.",
  empty: "That file is empty.",
  "too-large": "That photo is over 25 MB.",
  type: "Choose a JPEG, PNG, HEIC, HEIF or WebP photo.",
  "not-found": "That photo is gone.",
  "upload-gone": "The upload did not reach storage. Try again.",
  failed: "Something went wrong. Try again.",
};

interface Props {
  // The library as the server read it; Realtime keeps it live from there.
  initial: LibraryItem[];
}

// The owner's photo library beside the reel: the dashed add tile (or a file
// dropped on the section, on desktop) uploads one photo straight to storage
// (one signed part, never through the studio's server),
// each tile shows only its thumbnail (plus its status live while not ready),
// and a tile opens the photo with its description and tags. Every change to
// the owner's photos (RLS decides what arrives) re-reads the library through
// a server action, which signs the images; no key reaches the client. One read each time the subscription is
// ready covers changes made before it. No interval, no polling.
export function PhotoLibrary({ initial }: Props) {
  const [items, setItems] = useState(initial);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

  async function refresh() {
    const answer = await loadLibrary();
    if (answer.ok) setItems(answer.value);
  }

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    let active = true;
    const reread = () =>
      void loadLibrary().then((answer) => {
        if (active && answer.ok) setItems(answer.value);
      });
    const channel = supabase.channel(`photos-${crypto.randomUUID()}`);
    channel
      .on("system", {}, (message: { extension?: string; status?: string }) => {
        if (message.extension !== "postgres_changes" || message.status !== "ok") return;
        void loadLibrary().then((answer) => {
          if (!active) return;
          if (answer.ok) setItems(answer.value);
          setReady(true);
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, reread);
    // setAuth hands the session's token to Realtime before joining, so RLS
    // sees the owner.
    void supabase.realtime.setAuth().then(() => {
      if (active) channel.subscribe();
    });
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setMessage("");
    try {
      const started = await startPhotoUpload({ name: file.name, size: file.size, type: file.type });
      if (!started.ok) {
        setMessage(ERRORS[started.error]);
        return;
      }
      await refresh();
      const response = await fetch(started.value.url, { method: "PUT", body: file });
      const etag = response.headers.get("ETag");
      if (!response.ok || !etag) {
        setMessage(ERRORS["upload-gone"]);
        return;
      }
      const finished = await finishPhotoUpload(started.value.photoId, etag);
      if (!finished.ok) setMessage(ERRORS[finished.error]);
      await refresh();
    } catch {
      setMessage(ERRORS.failed);
    } finally {
      setBusy(false);
    }
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again still fires a change.
    event.target.value = "";
    if (file) void upload(file);
  }

  // A drop starts the same upload as a pick, for one photo the picker would
  // offer; anything else uploads nothing and says why.
  const drop = useFileDrop((files) => {
    if (busy) {
      setMessage(UPLOAD_RUNNING);
      return;
    }
    const decision = decideDrop(files, PHOTO_ACCEPT);
    if (decision.kind === "upload") void upload(decision.file);
    else if (decision.kind === "too-many") setMessage(TOO_MANY_FILES);
    else if (decision.kind === "refused") {
      setMessage(`${decision.name} is not a JPEG, PNG, HEIC, HEIF or WebP photo.`);
    }
  });

  async function onDelete(photoId: string): Promise<string | null> {
    const answer = await deletePhoto(photoId);
    if (!answer.ok) return ERRORS[answer.error];
    setItems((current) => current.filter((item) => item.id !== photoId));
    return null;
  }

  const tiles: ThumbnailGridItem[] = items.map((item) => ({
    id: item.id,
    onSelect: () => {
      setOpenId(item.id);
      dialogRef.current?.showModal();
    },
    label: photoTileLabel(item),
    imageUrl: item.thumbnailUrl,
    badge: photoBadge(item.status),
    badgeTestId: "photo-status",
  }));
  const open = items.find((item) => item.id === openId) ?? null;

  return (
    <section
      aria-labelledby="library-heading"
      data-library={ready ? "ready" : "pending"}
      data-testid="photo-drop"
      data-drop={drop.over ? "over" : "idle"}
      {...drop.handlers}
      className={`relative flex min-h-0 flex-1 flex-col ${drop.over ? DROP_ZONE_OVER : ""}`}
    >
      <div className="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
        <h2 id="library-heading" className="text-sm font-semibold">
          Photos
        </h2>
        <input
          ref={inputRef}
          type="file"
          accept={PHOTO_ACCEPT}
          onChange={onPick}
          data-testid="photo-input"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      {message && (
        <p role="alert" className="flex-none px-3 pb-2 text-sm text-danger">
          {message}
        </p>
      )}
      <div
        data-testid="photo-grid"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3"
      >
        <ThumbnailGrid
          label="Photos"
          items={tiles}
          empty={<p className="text-sm">No photos yet.</p>}
          aspect="square"
          columns="panel"
          add={{
            label: "Upload a photo",
            onAdd: () => inputRef.current?.click(),
            disabled: !hydrated || busy,
            ready: hydrated,
          }}
        />
      </div>
      {drop.over && <DropHint />}
      <PhotoDialog dialogRef={dialogRef} photo={open} onDelete={onDelete} />
    </section>
  );
}
