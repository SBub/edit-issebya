import { ISSEBYA_PRESET, type Edit } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { transcriptOf } from "../../test-support/eval-fixtures.ts";
import { decideInput, targetPicks } from "../decide/input.ts";
import { buildCuratorCase } from "./curator-input.ts";
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

const item = parseOwnerItem(ownerItemJson(TEXT, OWNER));

async function build(sources = fixtureSources(), parseCurrent = parseEditStub, dataset = item) {
  return buildCuratorCase({
    item: dataset,
    candidates: await runCandidates(sources),
    sources,
    preset: ISSEBYA_PRESET,
    parseCurrent,
  });
}

describe("the curator's input", () => {
  it("is the decide step's input over the latest version: its hook and the preset's intensity and target", async () => {
    const built = await build();
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
    const built = await build(
      fixtureSources({ run: runRecord({ target: 99, intensity: "calm" }) }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.case.notes).toEqual([
      `stored intensity calm differs from ${ISSEBYA_PRESET.intensity}`,
      `stored target 99 differs from ${built.case.input.target_picks}`,
    ]);
  });

  it("takes the hook from the latest run's AI record when the version has none", async () => {
    const edit = { tracks: { overlays: [] } } as unknown as Edit;
    const built = await build(
      fixtureSources({ run: runRecord({ hook: "from the run.", target: 3 }) }),
      () => ({ ok: true, edit }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.case.hook).toEqual({ text: "from the run", source: "ai record" });
    expect(built.case.notes).toContain(
      "the latest version has no hook: the hook is the latest run's AI record",
    );
  });

  it("skips a reel with no stored run of the dataset's words", async () => {
    const other = parseOwnerItem(ownerItemJson("completely other words here", {}));
    const built = await build(fixtureSources(), parseEditStub, other);
    expect(built).toEqual({ ok: false, reason: "no stored decide run has this transcript" });
  });

  it("skips a reel whose latest version has no version row", async () => {
    const built = await build(fixtureSources({ latest: null }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain("has no version");
  });

  it("skips a latest version whose transcript is not the dataset's words", async () => {
    const built = await build(
      fixtureSources({
        latest: { transcriptKey: "other-key" },
        json: { "other-key": transcriptOf("different words only") },
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("the latest version's transcript is not the dataset's words");
  });

  it("skips a latest version that does not parse, with the parse's reason", async () => {
    const built = await build(fixtureSources(), () => ({ ok: false, reasons: ["bad track"] }));
    expect(built).toEqual({ ok: false, reason: "the latest version does not parse: bad track" });
  });
});
