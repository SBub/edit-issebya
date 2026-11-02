import { assertStorageKey } from "@edit-issebya/storage";

// Where an export lives: `${prefix}exports/<reel_id>/<export_id>.mp4`.
export function exportKey(prefix: string, reelId: string, exportId: string): string {
  return assertStorageKey(`${prefix}exports/${reelId}/${exportId}.mp4`);
}
