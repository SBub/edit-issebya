"use client";

import { type DragEvent as ReactDragEvent, useEffect, useRef, useState } from "react";

// True when the drag carries files (not a link or selected text).
function carriesFiles(transfer: DataTransfer | null): boolean {
  return Array.from(transfer?.types ?? []).includes("Files");
}

// The zone's look while a file is dragged over it.
export const DROP_ZONE_OVER = "outline-2 outline-dashed outline-accent -outline-offset-4";

// A drop zone for files, on pointer devices (a phone never drags files; its
// add tile works by tap). A counter of entered elements keeps the highlight on
// while the pointer crosses the zone's children: each child fires its own
// enter and leave. A file dropped anywhere else on the page is ignored, never
// opened by the browser in place of the studio.
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // The window is an external system: the guard goes when the zone does. A
  // drag the zone already took (default prevented) is left alone.
  useEffect(() => {
    function guard(event: DragEvent) {
      if (event.defaultPrevented || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    }
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const handlers = {
    onDragEnter(event: ReactDragEvent<HTMLElement>) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver(event: ReactDragEvent<HTMLElement>) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(event: ReactDragEvent<HTMLElement>) {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop(event: ReactDragEvent<HTMLElement>) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      onFiles(Array.from(event.dataTransfer.files));
    },
  };

  return { over, handlers };
}

// Shown over the zone while a file is dragged over it. It takes no pointer
// events, so it never becomes the drag's target.
export function DropHint() {
  return (
    <p
      data-testid="drop-hint"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-surface/70 text-sm font-medium text-accent"
    >
      Drop to upload
    </p>
  );
}
