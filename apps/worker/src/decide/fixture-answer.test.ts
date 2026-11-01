import { readFile } from "node:fs/promises";
import { type HeadTrack, ISSEBYA, type Transcript, createMeasurer } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { fontBytes } from "../steps/version-io.ts";
import { evaluateAttempt } from "./attempt.ts";

const root = new URL("../../../../", import.meta.url);

async function json<T>(path: string): Promise<T> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as T;
}

// The upload E2E runs the fake AI on this script against the seeded
// short-speech cache; it must pass every check there, or the spec fails on a
// layout surprise instead of on the feature.
describe("the E2E decide script", () => {
  it("passes every check on the seeded fixtures", async () => {
    const [entry] = await json<{ output: unknown }[]>("fixtures/decide/short-speech.json");
    const transcript = await json<Transcript>("fixtures/pipeline/retime/transcript.json");
    const { durationSeconds } = await json<{ durationSeconds: number }>(
      "fixtures/pipeline/retime/retime.json",
    );
    const headTrack = await json<HeadTrack>("fixtures/pipeline/head_track/head-track.json");
    const measurer = createMeasurer(await fontBytes(ISSEBYA));
    try {
      const attempt = evaluateAttempt({
        output: entry!.output,
        context: { transcript, preset: ISSEBYA, clipDuration: durationSeconds },
        inputs: {
          footage: "1".repeat(64),
          transcript: "2".repeat(64),
          cutout: "3".repeat(64),
          headTrack: "4".repeat(64),
        },
        headTrack,
        measurer,
      });
      expect(attempt).toMatchObject({ ok: true, checks: { ok: true, reasons: [] } });
    } finally {
      measurer.close();
    }
  });
});
