import type { SoundStart } from "./sound-schedule";

export interface PreviewSoundRecord {
  // One per playback start: the audio context's time and the playhead then.
  playbacks: { ctxTime: number; playhead: number }[];
  starts: SoundStart[];
}

declare global {
  interface Window {
    // Set only under automation (navigator.webdriver), in memory only.
    __previewBuild?: string;
    __previewSounds?: PreviewSoundRecord;
  }
}

function automated(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true;
}

// The page exactly as packages/edit built it, before the preview transform.
export function recordPreviewBuild(html: string): void {
  if (automated()) window.__previewBuild = html;
}

// Every schedule the sound engine makes.
export function recordSoundSchedule(
  playback: { ctxTime: number; playhead: number },
  starts: readonly SoundStart[],
): void {
  if (!automated()) return;
  window.__previewSounds ??= { playbacks: [], starts: [] };
  window.__previewSounds.playbacks.push(playback);
  window.__previewSounds.starts.push(...starts);
}
