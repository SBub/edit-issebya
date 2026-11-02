"use client";

import { useEffect, useRef } from "react";
import {
  NOTIFY_STORAGE_KEY,
  type ReadySnapshot,
  readyBody,
  readyEvent,
  readyTitle,
} from "@/lib/ready-notice";

// When the open reel becomes ready (processed, or a new export) while the tab
// is hidden: the tab title becomes `Ready: <reel>` and, if the owner turned
// notifications on and the browser granted them, one system notification is
// shown. The saved title comes back when the tab is visible again. With the
// tab visible nothing happens; with it closed nothing can.
export function useReadyNotice({
  status,
  latestExportId,
  reelName,
}: ReadySnapshot & { reelName: string }): void {
  const previous = useRef<ReadySnapshot | null>(null);
  const savedTitle = useRef<string | null>(null);

  useEffect(() => {
    const next = { status, latestExportId };
    const event = readyEvent(previous.current, next);
    previous.current = next;
    if (!event || document.visibilityState !== "hidden") return;
    savedTitle.current ??= document.title;
    const title = readyTitle(reelName);
    document.title = title;
    if (
      localStorage.getItem(NOTIFY_STORAGE_KEY) === "on" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      const notification = new Notification(title, { body: readyBody(event) });
      notification.onclick = () => window.focus();
    }
  }, [status, latestExportId, reelName]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || savedTitle.current === null) return;
      document.title = savedTitle.current;
      savedTitle.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
}
