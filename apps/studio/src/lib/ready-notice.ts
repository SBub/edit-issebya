// When the open reel became ready: its status moved into `processed`, or a
// new export was recorded. Never on the first render (no previous snapshot).
export interface ReadySnapshot {
  status: string;
  latestExportId: string | null;
}

export type ReadyEvent = "processed" | "export";

export function readyEvent(previous: ReadySnapshot | null, next: ReadySnapshot): ReadyEvent | null {
  if (!previous) return null;
  if (previous.status !== "processed" && next.status === "processed") return "processed";
  if (next.latestExportId !== null && next.latestExportId !== previous.latestExportId) {
    return "export";
  }
  return null;
}

export function readyTitle(reelName: string): string {
  return `Ready: ${reelName}`;
}

// The notification's text under its title.
export function readyBody(event: ReadyEvent): string {
  return event === "processed" ? "Your reel is processed." : "Your export is ready to download.";
}

// The owner's "Notify me" choice in this browser.
export const NOTIFY_STORAGE_KEY = "studio-notify";
