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

async function evaluate(script: string) {
  const [entry] = await json<{ output: unknown }[]>(script);
  const transcript = await json<Transcript>("fixtures/pipeline/retime/transcript.json");
  const { durationSeconds } = await json<{ durationSeconds: number }>(
    "fixtures/pipeline/retime/retime.json",
  );
  const headTrack = await json<HeadTrack>("fixtures/pipeline/head_track/head-track.json");
  const measurer = createMeasurer(await fontBytes(ISSEBYA));
  try {
    return evaluateAttempt({
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
  } finally {
    measurer.close();
  }
}

// The E2E specs run the fake AI on these scripts against the seeded
// short-speech cache; a passing one must pass every check there, or a spec
// fails on a layout surprise instead of on the feature.
describe("the E2E decide scripts", () => {
  it("passes every check on the seeded fixtures", async () => {
    expect(await evaluate("fixtures/decide/short-speech.json")).toMatchObject({
      ok: true,
      checks: { ok: true, reasons: [] },
    });
  });

  it("passes with the change request's answer, which differs from the first", async () => {
    const changed = await evaluate("fixtures/decide/change-request.json");
    const first = await evaluate("fixtures/decide/short-speech.json");
    expect(changed).toMatchObject({ ok: true, checks: { ok: true, reasons: [] } });
    if (!changed.ok || !first.ok) throw new Error("both scripts must pass");
    expect(changed.edit).not.toEqual(first.edit);
  });

  it("fails the schema with readable reasons on the fail-twice answer", async () => {
    const broken = await evaluate("fixtures/decide/fail-twice.json");
    if (broken.ok) throw new Error("the fail-twice script must fail");
    expect(broken.reasons).toContainEqual(expect.stringMatching(/^schema: /));
  });
});
