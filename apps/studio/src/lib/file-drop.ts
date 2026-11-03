// What a drop of files onto an upload zone does: one accepted file uploads,
// anything else uploads nothing. Pure, so the decision is tested without a
// browser; the components only turn it into an upload or a message.

// The part of a File the decision reads.
export interface DroppedFile {
  name: string;
  type: string;
}

export type DropDecision<F extends DroppedFile> =
  | { kind: "upload"; file: F }
  | { kind: "none" }
  | { kind: "too-many" }
  | { kind: "refused"; name: string };

// What a refused drop says.
export const TOO_MANY_FILES = "One file at a time, for now";
export const UPLOAD_RUNNING = "An upload is running. Drop the next file when it finishes";

// True when the file picker would offer the file: an `accept` token is an
// extension (`.mov`, against the name), a whole family (`image/*`) or an
// exact type (`video/mp4`). Case does not matter.
export function acceptsFile(accept: string, file: DroppedFile): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .some((token) => {
      if (token.startsWith(".")) return name.endsWith(token);
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
      return type === token;
    });
}

// Several files: none uploads. One the picker would not offer: refused by
// name. No file at all (a dragged link or text): nothing happens.
export function decideDrop<F extends DroppedFile>(
  files: readonly F[],
  accept: string,
): DropDecision<F> {
  if (files.length === 0) return { kind: "none" };
  if (files.length > 1) return { kind: "too-many" };
  const file = files[0]!;
  return acceptsFile(accept, file)
    ? { kind: "upload", file }
    : { kind: "refused", name: file.name };
}
