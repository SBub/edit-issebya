import { describe, expect, it } from "vitest";
import { ownerItemJson, transcriptOf } from "../../test-support/eval-fixtures.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { EDIT, HOOK, parseEditStub } from "../../test-support/curator-fixtures.ts";
import { snapshotItems, SNAPSHOT_AT } from "../../test-support/snapshot-fixtures.ts";
import { type AiRequest, type AiRunner, NO_USAGE, type AiExchange } from "../ai.ts";
import { createTelemetry } from "../telemetry.ts";
import type { CuratorSources } from "./curator-input.ts";
import { runCuratorEval } from "./run-curator.ts";
import { runJudgeEval } from "./run-eval.ts";
import { selectOwnerItems } from "./owner-marks.ts";
import type { EvalsApi, UpdateItemBody } from "./posthog-evals.ts";
import { curatorInputOf, missingSnapshot, pastRunsOf, storedRunOf } from "./snapshot-format.ts";
import { planSnapshot, runSnapshot, snapshotBody } from "./snapshot.ts";

// Two reels share one transcript (a re-upload of the same footage). Reel A also
// has an older run decided from another transcript, which is left out.
const TEXT = "we work to live and we live to work every day";
const OTHER = "a different transcript of other words";
const REEL_A = "aaaaaaaa-0000-4000-8000-000000000001";
const REEL_B = "bbbbbbbb-0000-4000-8000-000000000002";
const V2 = "00000000-0000-4000-8000-0000000000a2";
const V3 = "00000000-0000-4000-8000-0000000000a3";
const V4 = "00000000-0000-4000-8000-0000000000a4";
const runKey = (version: string) => `dev/reels/x/versions/${version}.ai.json`;

const record = (answer: unknown) => ({
  prompt_version: "reel-components@v7",
  intensity: "intense",
  target_picks: 2,
  calls: [{ role: "decide", answerText: JSON.stringify(answer) }],
});

// An in-memory store of stored runs and versions, read through the sources' interface.
function store(): CuratorSources {
  const versions: Record<string, { number: number; transcriptKey: string; reel: string }> = {
    [V2]: { number: 2, transcriptKey: "t-a", reel: REEL_A },
    [V3]: { number: 1, transcriptKey: "t-b", reel: REEL_B },
    [V4]: { number: 3, transcriptKey: "t-other", reel: REEL_A },
  };
  const json: Record<string, unknown> = {
    "t-a": transcriptOf(TEXT),
    "t-b": transcriptOf(TEXT),
    "t-other": transcriptOf(OTHER),
    "head-a": [],
    "edit-a": EDIT,
    [runKey(V2)]: record({ accents: [{ from: "w2", to: "w4" }] }),
    [runKey(V3)]: record({ big_words: [{ from: "w11", to: "w11" }] }),
    [runKey(V4)]: record({ accents: [{ from: "w1", to: "w1" }] }),
  };
  const files = [
    { reelId: REEL_A, key: runKey(V2) },
    { reelId: REEL_B, key: runKey(V3) },
    { reelId: REEL_A, key: runKey(V4) },
  ];
  return {
    async aiFiles() {
      return files;
    },
    async versions(ids) {
      return ids.flatMap((id) => {
        const row = versions[id];
        return row ? [{ id, number: row.number, transcriptKey: row.transcriptKey }] : [];
      });
    },
    async readJson(key) {
      return key in json ? json[key] : null;
    },
    async latestVersion(reelId) {
      return reelId === REEL_A
        ? {
            id: V2,
            number: 2,
            editKey: "edit-a",
            transcriptKey: "t-a",
            headTrackKey: "head-a",
          }
        : null;
    },
  };
}

const RAW = [
  ownerItemJson(
    TEXT,
    { accent: [{ start: 1, end: 3.5, words: "work to live" }] },
    {
      reelId: "aaaaaaaa",
      id: "item-a",
    },
  ),
];

// The item's plan, read once for the update tests.
const [PLAN] = await planSnapshot(selectOwnerItems(RAW), store(), { parseCurrent: parseEditStub });

describe("the snapshot plan", () => {
  it("copies every run decided from the item's words (a re-upload included) and leaves out a run of another transcript", async () => {
    const [plan] = await planSnapshot(selectOwnerItems(RAW), store(), {
      parseCurrent: parseEditStub,
    });
    expect(plan!.runs.map((run) => run.versionId)).toEqual([V2, V3]);
    expect(plan!.runs.map((run) => run.reelId)).toEqual([REEL_A, REEL_B]);
    expect(plan!.differing).toBe(1);
    expect(plan!.versionIds).toEqual([V2, V3]);
    expect(plan!.curator).toMatchObject({
      status: "ready",
      reel_id: REEL_A,
      version_id: V2,
      version_number: 2,
      preset: "issebya",
      hook: { text: HOOK, source: "version" },
      stored_run: { intensity: "intense", target_picks: 2 },
    });
  });

  it("records a skipped curator input with its reason, and keeps the runs", async () => {
    const sources = { ...store(), latestVersion: async () => null };
    const [plan] = await planSnapshot(selectOwnerItems(RAW), sources, {
      parseCurrent: parseEditStub,
    });
    expect(plan!.curator).toEqual({ status: "skipped", reason: `reel ${REEL_A} has no version` });
    expect(plan!.runs).toHaveLength(2);
  });
});

describe("the item update", () => {
  const plan = PLAN;

  it("keeps everything the item already holds and adds the snapshot's fields", () => {
    const raw = RAW[0] as { input: object; expected_output: object; metadata: object };
    const body = snapshotBody(plan!, SNAPSHOT_AT);
    expect(body.base_version).toBe(1);
    expect(body.input).toEqual({ ...raw.input, curator_input: plan!.curator });
    expect(body.expected_output).toEqual(raw.expected_output);
    expect(body.metadata).toEqual({
      ...raw.metadata,
      past_curator_runs: plan!.runs.map(storedRunOf),
      snapshot_at: SNAPSHOT_AT,
      snapshot_source_version_ids: [V2, V3],
      snapshot_differing_runs: 1,
    });
  });

  it("refuses an item that does not serve its version, since the write could be stale", () => {
    const noVersion = { ...(RAW[0] as Record<string, unknown>) };
    delete noVersion.version;
    expect(() =>
      snapshotBody({ ...plan!, item: { ...plan!.item, raw: noVersion } }, SNAPSHOT_AT),
    ).toThrow(/does not serve its version/);
  });

  it("reads back to the same runs and curator input the evals use", async () => {
    const dataset = await snapshotItems(RAW, store(), { parseCurrent: parseEditStub });
    const [raw] = dataset as Record<string, unknown>[];
    expect(pastRunsOf(raw, "item-a")).toEqual(plan!.runs);
    expect(curatorInputOf(raw, "item-a")).toEqual(plan!.curator);
  });

  it("reads an item with no snapshot as null, and a malformed one with the command to run", () => {
    expect(pastRunsOf(RAW[0], "item-a")).toBeNull();
    expect(curatorInputOf(RAW[0], "item-a")).toBeNull();
    const broken = { metadata: { past_curator_runs: [{ reel_id: 3 }] } };
    expect(() => pastRunsOf(broken, "item-a")).toThrow(/malformed snapshot.*eval:snapshot again/);
  });
});

// A PostHog dataset of the item, with its updates recorded.
function posthogOf(items: unknown[]) {
  const updates: { id: string; body: UpdateItemBody }[] = [];
  const posthog: Pick<EvalsApi, "dataset" | "updateItem"> = {
    async dataset() {
      return { revisionId: "rev-7", revision: 7, items };
    },
    async updateItem(id, body) {
      updates.push({ id, body });
    },
  };
  return { posthog, updates };
}

describe("running the snapshot", () => {
  it("a dry run prints what would be written and writes nothing", async () => {
    const { posthog, updates } = posthogOf(RAW);
    const lines: string[] = [];
    const summary = await runSnapshot(
      { datasetId: "data-set", dryRun: true },
      { posthog, sources: store(), parseCurrent: parseEditStub, log: (line) => lines.push(line) },
    );
    expect(updates).toEqual([]);
    expect(summary.written).toBe(0);
    expect(lines).toContain(
      `reel aaaaaaaa: 2 curator runs (2 picks), 1 runs of this reel left out (another transcript), curator input ready from version 2, hook from version`,
    );
    expect(lines.at(-1)).toBe("dry run: 1 items would get a new version, nothing written");
  });

  it("writes one new version per item, at the version it read", async () => {
    const { posthog, updates } = posthogOf(RAW);
    const summary = await runSnapshot(
      { datasetId: "data-set", dryRun: false },
      {
        posthog,
        sources: store(),
        parseCurrent: parseEditStub,
        log: () => undefined,
        now: () => new Date(SNAPSHOT_AT),
      },
    );
    expect(summary.written).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("item-a");
    expect(updates[0]!.body.base_version).toBe(1);
    expect(updates[0]!.body.metadata).toMatchObject({ snapshot_at: SNAPSHOT_AT });
  });

  it("narrows to one reel by its id prefix, and fails on a reel the dataset does not have", async () => {
    const other = ownerItemJson(OTHER, {}, { reelId: "cccccccc", id: "item-c" });
    const { posthog, updates } = posthogOf([...RAW, other]);
    await runSnapshot(
      { datasetId: "data-set", dryRun: false, reel: "aaaa" },
      { posthog, sources: store(), parseCurrent: parseEditStub, log: () => undefined },
    );
    expect(updates.map((update) => update.id)).toEqual(["item-a"]);
    await expect(
      runSnapshot(
        { datasetId: "data-set", dryRun: true, reel: "dddd" },
        { posthog, sources: store(), log: () => undefined },
      ),
    ).rejects.toThrow("no labelled reel dddd");
  });

  it("names how far it got when a write fails, so the run can be repeated", async () => {
    const items = [RAW[0], ownerItemJson(OTHER, {}, { reelId: "cccccccc", id: "item-c" })];
    let calls = 0;
    const posthog: Pick<EvalsApi, "dataset" | "updateItem"> = {
      async dataset() {
        return { revisionId: "rev-7", revision: 7, items };
      },
      async updateItem() {
        calls += 1;
        if (calls === 2) throw new Error("evals: PostHog answered HTTP 409");
      },
    };
    await expect(
      runSnapshot(
        { datasetId: "data-set", dryRun: false },
        { posthog, sources: store(), parseCurrent: parseEditStub, log: () => undefined },
      ),
    ).rejects.toThrow("stopped after 1 of 2 items, run the snapshot again to finish");
  });
});

// The evals see an item with no snapshot: they stop before any call, naming the command.
describe("an item with no snapshot", () => {
  const fakeAi = () => {
    const calls: AiRequest[] = [];
    const ai: AiRunner = {
      async call(request) {
        calls.push(request);
        return { kind: "answer", answer: {}, usage: NO_USAGE, exchange: {} as AiExchange };
      },
    };
    return { ai, calls };
  };
  const noWrite = (): EvalsApi => ({
    async dataset() {
      return { revisionId: "rev-7", revision: 7, items: RAW };
    },
    async updateItem() {
      throw new Error("no write expected");
    },
    async scorerVersion() {
      throw new Error("no scorer expected");
    },
    async createExperiment() {
      throw new Error("no experiment expected");
    },
    async upload() {
      throw new Error("no upload expected");
    },
    async complete() {},
    async fail() {},
  });

  it("the judge eval stops before any judge call, naming eval:snapshot", async () => {
    const { ai, calls } = fakeAi();
    await expect(
      runJudgeEval(
        { datasetId: "data-set", dryRun: false },
        {
          posthog: noWrite(),
          prompts: fakePromptSource(),
          ai,
          telemetry: createTelemetry({}),
          saveReport: async () => "x",
          log: () => undefined,
        },
      ),
    ).rejects.toThrow(missingSnapshot("item-a", "metadata.past_curator_runs"));
    expect(calls).toEqual([]);
  });

  it("the curator eval stops before any curator call, naming eval:snapshot", async () => {
    const { ai, calls } = fakeAi();
    await expect(
      runCuratorEval(
        { datasetId: "data-set", dryRun: false, repeats: 1 },
        {
          posthog: noWrite(),
          curatorPrompts: fakePromptSource(),
          judgePrompts: fakePromptSource(),
          ai,
          telemetry: createTelemetry({}),
          measurerOf: async () => ({}) as never,
          saveReport: async () => "x",
          log: () => undefined,
        },
      ),
    ).rejects.toThrow(/run yarn workspace @edit-issebya\/worker eval:snapshot first/);
    expect(calls).toEqual([]);
  });
});
