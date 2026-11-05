import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

// The absolute path of an executable: a name with a slash is taken as it is,
// a bare name is looked up on PATH. Null when there is none.
export function resolveExecutable(name: string, path = process.env.PATH ?? ""): string | null {
  const candidates = name.includes("/")
    ? [resolve(name)]
    : path
        .split(delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same candidate
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there or not executable: try the next.
    }
  }
  return null;
}
