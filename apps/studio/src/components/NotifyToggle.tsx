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
      <p
        data-testid="notify-blocked"
        title="Notifications blocked in this browser"
        className="hidden flex-none text-xs text-muted sm:block"
      >
        Notifications blocked
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

  // Compact in the header: an icon under `sm`, the words from `sm` up; the
  // accessible name is the words at every size.
  const label = current === "on" ? "Notifications on" : "Notify me when ready";
  return (
    <button
      type="button"
      data-testid="notify-toggle"
      aria-pressed={current === "on"}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex flex-none items-center gap-1 rounded-full border border-line bg-raised px-2 py-1 text-sm text-ink hover:bg-line sm:px-3"
    >
      <span aria-hidden="true" className="sm:hidden">
        {current === "on" ? "\u{1F514}" : "\u{1F515}"}
      </span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
