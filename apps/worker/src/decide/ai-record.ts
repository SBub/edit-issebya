import type { Storage } from "@edit-issebya/storage";
import type { AiExchange } from "../ai.ts";

// THE VERSION'S AI RECORD: every AI call a decide made for a version (each
// hook attempt, each decide attempt, each editorial round, the title and
// summary), with the
// prompt and schema sent and the raw answer, so the version can be replayed
// and diagnosed. One JSON file next to the version's edit, written once,
// kept like the version itself. Never a key, never an image.

// Where a version's AI record lives: beside `versions/<id>.json`.
export function aiRecordKey(prefix: string, reelId: string, versionId: string): string {
  return `${prefix}reels/${reelId}/versions/${versionId}.ai.json`;
}

// One call in the record: what it was for, the attempt or round it belongs
// to, and the exchange.
export interface AiRecordCall extends AiExchange {
  // The hook or decide attempt (1 or 2), the editorial round (1 on), or 1 for the summary.
  attempt: number;
}

export interface AiRecord {
  format: 1;
  reel_id: string;
  version_id: string;
  prompt_version: string;
  hook_prompt_version: string;
  summary_prompt_version: string;
  calls: AiRecordCall[];
}

// The record's bytes, written put-if-absent (a version id is never reused).
export async function writeAiRecord(
  storage: Pick<Storage, "putIfAbsent">,
  keyPrefix: string,
  record: AiRecord,
): Promise<string> {
  const key = aiRecordKey(keyPrefix, record.reel_id, record.version_id);
  const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2));
  if ((await storage.putIfAbsent(key, bytes, { contentType: "application/json" })) === "exists") {
    throw new Error(`AI record exists, records are never rewritten: ${key}`);
  }
  return key;
}
