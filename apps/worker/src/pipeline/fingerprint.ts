import { createHash } from "node:crypto";
import { assertStorageKey } from "@edit-issebya/storage";
import { canonicalJson } from "./canonical-json.ts";

// What a step reads: the uploaded source, by its storage ETag and size (one
// HEAD, no download), or an earlier step's output, by its producer: cached
// outputs never change under their fingerprint, so it names their content.
export type FileRef =
  { source: { etag: string; bytes: number } } | { step: string; fingerprint: string; file: string };

// SHA-256 hex of the canonical JSON of everything a step's outputs depend on.
export function fingerprint({
  inputs,
  settings,
  version,
}: {
  inputs: FileRef[];
  settings: unknown;
  version: number;
}): string {
  return createHash("sha256").update(canonicalJson({ inputs, settings, version })).digest("hex");
}

// Where a step's output lives: `${prefix}cache/<step>/<fingerprint>/<file>`.
export function cacheKey(prefix: string, step: string, fp: string, file: string): string {
  return assertStorageKey(`${prefix}cache/${step}/${fp}/${file}`);
}
