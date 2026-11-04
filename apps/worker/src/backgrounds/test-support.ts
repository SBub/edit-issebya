// Test helper: the fixture clip's committed background map (made from
// fixtures/pipeline/retime/source.mp4 by background-map.ts), stored where
// ensureBackgrounds looks for it, so a test runs no ffmpeg.
import { readFile } from "node:fs/promises";
import type { Storage } from "@edit-issebya/storage";
import { backgroundsKey } from "./ensure-backgrounds.ts";

export const FIXTURE_BACKGROUNDS = new URL(
  "../../../../packages/edit/src/testdata/backgrounds/short-speech.backgrounds.json",
  import.meta.url,
);

export async function storeFixtureBackgrounds(
  storage: Storage,
  prefix: string,
  fingerprints: Record<string, string>,
): Promise<string> {
  const key = backgroundsKey(prefix, {
    step: "retime",
    fingerprint: fingerprints.retime!,
    file: "source.mp4",
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  await storage.put(key, new Uint8Array(await readFile(FIXTURE_BACKGROUNDS)));
  return key;
}
