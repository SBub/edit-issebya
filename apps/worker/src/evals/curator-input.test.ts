import { ISSEBYA_PRESET, type Edit } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { transcriptOf } from "../../test-support/eval-fixtures.ts";
import { decideInput, targetPicks } from "../decide/input.ts";
import { curatorCaseOf, snapshotCuratorInput } from "./curator-input.ts";
import { runCandidates } from "./curator-runs.ts";
import {
  HOOK,
  OWNER,
  TEXT,
  fixtureSources,
  parseEditStub,
  runRecord,
} from "../../test-support/curator-fixtures.ts";
import { parseOwnerItem } from "./owner-marks.ts";
import { ownerItemJson } from "../../test-support/eval-fixtures.ts";
import type { StoredCuratorInput } from "./snapshot-format.ts";

const item = parseOwnerItem(ownerItemJson(TEXT, OWNER));

// The snapshot side: the stored input of the item, read from the sources.
async function snapshot(
  sources = fixtureSources(),
  parseCurrent = parseEditStub,
  dataset = item,
): Promise<StoredCuratorInput> {
  return snapshotCuratorInput({
    item: dataset,
    candidates: await runCandidates(sources),
    sources,
    preset: ISSEBYA_PRESET,
    parseCurrent,
  });
}

// The eval side: the case rebuilt from a stored input, with no other read.
function caseOf(stored: StoredCuratorInput) {
  return curatorCaseOf({ item, stored, preset: ISSEBYA_PRESET, parseCurrent: parseEditStub });
}

describe("the snapshot of the curator's input", () => {
  it("stores the latest version's transcript, head track, edit, hook and the run's stored values", async () => {
    const stored = await snapshot();
    expect(stored).toMatchObject({
      status: "ready",
      reel_id: expect.any(String),
      version_number: 2,
      preset: ISSEBYA_PRESET.id,
      transcript: transcriptOf(TEXT),
      head_track: [],
      hook: { text: HOOK, source: "version" },
    });
    expect(stored.status === "ready" && stored.stored_run).toEqual({
      intensity: ISSEBYA_PRESET.intensity,
      target_picks: 3,
    });
  });

  it("takes the hook from the latest run's AI record when the version has none", async () => {
    const edit = { tracks: { overlays: [] } } as unknown as Edit;
    const stored = await snapshot(
      fixtureSources({ run: runRecord({ hook: "from the run.", target: 3 }) }),
      () => ({ ok: true, edit }),
    );
    expect(stored).toMatchObject({
      status: "ready",
      hook: { text: "from the run", source: "ai record" },
    });
  });

  it("skips a reel with no stored run of the dataset's words, with the reason", async () => {
    const other = parseOwnerItem(ownerItemJson("completely other words here", {}));
    expect(await snapshot(fixtureSources(), parseEditStub, other)).toEqual({
      status: "skipped",
      reason: "no stored decide run has this transcript",
    });
  });

  it("skips a reel whose latest version has no version row", async () => {
    const stored = await snapshot(fixtureSources({ latest: null }));
    expect(stored).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("has no version"),
    });
  });

  it("skips a latest version whose transcript is not the dataset's words", async () => {
    const stored = await snapshot(
      fixtureSources({
        latest: { transcriptKey: "other-key" },
        json: { "other-key": transcriptOf("different words only") },
      }),
    );
    expect(stored).toEqual({
      status: "skipped",
      reason: "the latest version's transcript is not the dataset's words",
    });
  });

  it("skips a latest version that does not parse, with the parse's reason", async () => {
    const stored = await snapshot(fixtureSources(), () => ({ ok: false, reasons: ["bad track"] }));
    expect(stored).toEqual({
      status: "skipped",
      reason: "the latest version does not parse: bad track",
    });
  });
});

describe("the curator's case, rebuilt from the snapshot", () => {
  it("is the decide step's input: the stored hook, and the preset's intensity and target", async () => {
    const stored = await snapshot();
    const built = caseOf(stored);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const transcript = transcriptOf(TEXT);
    expect(built.case.input).toEqual(
      decideInput({ transcript, preset: ISSEBYA_PRESET, hook: { text: HOOK } }),
    );
    expect(built.case.input.target_picks).toBe(targetPicks(transcript, ISSEBYA_PRESET));
    expect(built.case.hook).toEqual({ text: HOOK, source: "version" });
    expect(built.case.versionNumber).toBe(2);
    expect(built.case.notes).toEqual([]);
  });

  it("notes a stored target or intensity that the reproduced input does not match", async () => {
    const built = caseOf(
      await snapshot(fixtureSources({ run: runRecord({ target: 99, intensity: "calm" }) })),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.case.notes).toEqual([
      `stored intensity calm differs from ${ISSEBYA_PRESET.intensity}`,
      `stored target 99 differs from ${built.case.input.target_picks}`,
    ]);
  });

  it("notes a hook taken from the latest run's AI record", async () => {
    const edit = { tracks: { overlays: [] } } as unknown as Edit;
    const built = caseOf(
      await snapshot(
        fixtureSources({ run: runRecord({ hook: "from the run.", target: 3 }) }),
        () => ({
          ok: true,
          edit,
        }),
      ),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.case.hook).toEqual({ text: "from the run", source: "ai record" });
    expect(built.case.notes).toContain(
      "the latest version has no hook: the hook is the latest run's AI record",
    );
  });

  it("passes a skipped snapshot on with its reason, and reads nothing else", async () => {
    const built = caseOf({ status: "skipped", reason: "reel x has no version" });
    expect(built).toEqual({ ok: false, reason: "reel x has no version" });
  });

  it("refuses a snapshot taken with another preset", async () => {
    const stored = await snapshot();
    if (stored.status !== "ready") throw new Error("expected a ready snapshot");
    const built = caseOf({ ...stored, preset: "other" });
    expect(built).toEqual({
      ok: false,
      reason: `the snapshot was taken with preset other, not ${ISSEBYA_PRESET.id}`,
    });
  });

  it("refuses a snapshot whose edit no longer parses", async () => {
    const stored = await snapshot();
    if (stored.status !== "ready") throw new Error("expected a ready snapshot");
    const built = curatorCaseOf({
      item,
      stored,
      preset: ISSEBYA_PRESET,
      parseCurrent: () => ({ ok: false, reasons: ["bad track"] }),
    });
    expect(built).toEqual({ ok: false, reason: "the snapshot's edit does not parse: bad track" });
  });
});
