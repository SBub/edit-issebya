"use client";

import { useSyncExternalStore } from "react";
import { NOTIFY_STORAGE_KEY } from "@/lib/ready-notice";

type Mode = "unknown" | "unsupported" | "off" | "on" | "blocked";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function changed(): void {
  for (const listener of listeners) listener();
}

function mode(): Mode {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission === "granted" && localStorage.getItem(NOTIFY_STORAGE_KEY) === "on") {
    return "on";
  }
  return "off";
}

// Turns the ready notification on for this browser. Permission is asked only
// from the click, never on load; the choice is kept in localStorage. Hidden
// where the browser has no Notification API (the tab title still changes).
export function NotifyToggle() {
  const current = useSyncExternalStore(subscribe, mode, () => "unknown" as const);
  if (current === "unknown" || current === "unsupported") return null;
  if (current === "blocked") {
    return (
      <p data-testid="notify-blocked" className="text-sm text-stone-600">
        Notifications blocked in this browser
      </p>
    );
  }

  const onClick = () => {
    if (current === "on") {
      localStorage.removeItem(NOTIFY_STORAGE_KEY);
      changed();
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") localStorage.setItem(NOTIFY_STORAGE_KEY, "on");
      changed();
    });
  };

  return (
    <button
      type="button"
      data-testid="notify-toggle"
      aria-pressed={current === "on"}
      onClick={onClick}
      className="self-start rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 hover:bg-stone-50"
    >
      {current === "on" ? "Notifications on" : "Notify me when ready"}
    </button>
  );
}
