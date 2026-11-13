import { describe, expect, it } from "vitest";
import { ownerItemJson, transcriptOf } from "../../test-support/eval-fixtures.ts";
import {
  AI_KEY,
  EDIT,
  HOOK,
  parseEditStub,
  REEL,
  runRecord,
  TEXT,
  VERSION,
} from "../../test-support/curator-fixtures.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { snapshotItems, SNAPSHOT_AT } from "../../test-support/snapshot-fixtures.ts";
import { type AiRequest, type AiRunner, type AiExchange, NO_USAGE } from "../ai.ts";
import { createTelemetry } from "../telemetry.ts";
import type { CuratorSources, LatestVersion } from "./curator-input.ts";
import { selectOwnerItems } from "./owner-marks.ts";
import type { Dataset, EvalsApi, UpdateItemBody } from "./posthog-evals.ts";
import { refreshDataset, refreshedPosthog, staleReasons } from "./refresh.ts";
import { runJudgeEval } from "./run-eval.ts";
import { planSnapshot } from "./snapshot.ts";

// The refresh step (app_docs/evals.md, "What happens automatically"): the stale
// check, the writes it makes, and the dataset the evals read after it. The app's
// data is an in-memory store here, and PostHog is a fake that applies each update
// as PostHog does (a new version, refused when `base_version` is out of date).

const V3 = "00000000-0000-4000-8000-0000000000a3";
const V4 = "00000000-0000-4000-8000-0000000000a4";
const runKey = (version: string) => `dev/reels/${REEL}/versions/${version}.ai.json`;

interface Store {
  latest: LatestVersion | null;
  files: { reelId: string; key: string }[];
  versions: Record<string, { number: number; transcriptKey: string }>;
  json: Record<string, unknown>;
}

// One reel: a decide run of TEXT on version 2, which is the latest version.
function storeOf(): Store {
  return {
    latest: {
      id: VERSION,
      number: 2,
      editKey: "edit-key",
      transcriptKey: "transcript-key",
      headTrackKey: "head-key",
    },
    files: [{ reelId: REEL, key: AI_KEY }],
    versions: { [VERSION]: { number: 2, transcriptKey: "transcript-key" } },
    json: {
      "transcript-key": transcriptOf(TEXT),
      "head-key": [],
      "edit-key": EDIT,
      [AI_KEY]: runRecord({ target: 3 }),
    },
  };
}

// The sources read the store as it is at each call, so a test changes the app's data in place.
function sourcesOf(store: Store): CuratorSources {
  return {
    async aiFiles() {
      return store.files;
    },
    async versions(ids) {
      return ids.flatMap((id) => (store.versions[id] ? [{ id, ...store.versions[id]! }] : []));
    },
    async readJson(key) {
      return key in store.json ? store.json[key] : null;
    },
    async latestVersion() {
      return store.latest;
    },
  };
}

const RAW = [
  ownerItemJson(
    TEXT,
    { accent: [{ start: 1, end: 3.5, words: "work to live" }] },
    { reelId: "aaaaaaaa", id: "item-a" },
  ),
];

// A PostHog dataset of the items, with the updates it receives applied as PostHog applies them.
interface FakeItem {
  id: string;
  version: number;
  input: unknown;
  metadata: Record<string, unknown>;
  expected_output?: unknown;
}

function fakePosthog(initial: unknown[], { failAt }: { failAt?: number } = {}) {
  const items = (initial as FakeItem[]).map((item) => structuredClone(item));
  const updates: { id: string; body: UpdateItemBody }[] = [];
  let revision = 7;
  const api: Pick<EvalsApi, "dataset" | "updateItem"> = {
    async dataset(): Promise<Dataset> {
      return { revisionId: `rev-${revision}`, revision, items: structuredClone(items) };
    },
    async updateItem(id, body) {
      if (failAt !== undefined && updates.length + 1 === failAt) {
        throw new Error("evals: PostHog answered HTTP 409");
      }
      const item = items.find((one) => one.id === id)!;
      if (body.base_version !== item.version) throw new Error("evals: stale base_version");
      updates.push({ id, body });
      item.version += 1;
      item.input = body.input;
      item.metadata = body.metadata;
      if (body.expected_output !== undefined) item.expected_output = body.expected_output;
      revision += 1;
    },
  };
  return { api, updates, items };
}

const quiet = { log: () => undefined, now: () => new Date(SNAPSHOT_AT) };

// The item as a snapshot left it: fresh against `store`.
async function freshItems(store: Store): Promise<unknown[]> {
  return snapshotItems(RAW, sourcesOf(store), { parseCurrent: parseEditStub });
}

async function reasonsOf(raw: unknown[], store: Store): Promise<string[]> {
  const [plan] = await planSnapshot(selectOwnerItems(raw), sourcesOf(store), {
    parseCurrent: parseEditStub,
  });
  return staleReasons(plan!);
}

describe("the stale check", () => {
  it("a snapshot read from the same data is fresh", async () => {
    const store = storeOf();
    expect(await reasonsOf(await freshItems(store), store)).toEqual([]);
  });

  it("an item with no snapshot is stale", async () => {
    expect(await reasonsOf(RAW, storeOf())).toEqual(["no snapshot yet"]);
  });

  it("a new version of the reel is stale: the snapshot read its version 2", async () => {
    const store = storeOf();
    const raw = await freshItems(store);
    store.latest = { ...store.latest!, id: V3, number: 3 };
    store.versions[V3] = { number: 3, transcriptKey: "transcript-key" };
    expect(await reasonsOf(raw, store)).toEqual([
      "a new version or curator run",
      "the curator input changed",
    ]);
  });

  it("a new curator run of the reel is stale", async () => {
    const store = storeOf();
    const raw = await freshItems(store);
    store.files.push({ reelId: REEL, key: runKey(V4) });
    store.versions[V4] = { number: 2, transcriptKey: "transcript-key" };
    store.json[runKey(V4)] = runRecord({ target: 4 });
    expect(await reasonsOf(raw, store)).toEqual(["a new version or curator run"]);
  });

  it("a curator input that reads differently now is stale, though its versions are the same", async () => {
    const store = storeOf();
    const raw = await freshItems(store);
    store.json["edit-key"] = {
      tracks: { overlays: [{ kind: "hook", id: "hook-1", text: `${HOOK} changed` }] },
    };
    expect(await reasonsOf(raw, store)).toEqual(["the curator input changed"]);
  });

  it("the key order of a stored input does not make it stale (PostHog reorders keys)", async () => {
    const store = storeOf();
    const raw = (await freshItems(store)) as {
      input: { curator_input: Record<string, unknown> };
    }[];
    const reordered = raw.map((item) => ({
      ...item,
      input: {
        ...item.input,
        curator_input: Object.fromEntries(Object.entries(item.input.curator_input).reverse()),
      },
    }));
    expect(await reasonsOf(reordered, store)).toEqual([]);
  });
});

describe("the refresh step", () => {
  it("writes nothing and says so when every snapshot is fresh", async () => {
    const store = storeOf();
    const { api, updates } = fakePosthog(await freshItems(store));
    const lines: string[] = [];
    const result = await refreshDataset(
      { datasetId: "data-set", dryRun: false },
      {
        posthog: api,
        sources: sourcesOf(store),
        parseCurrent: parseEditStub,
        ...quiet,
        log: (line) => lines.push(line),
      },
    );
    expect(updates).toEqual([]);
    expect(result.refreshed).toEqual([]);
    expect(lines).toEqual(["snapshot: all 1 labelled reels are up to date"]);
  });

  it("refreshes a stale reel once, prints one line for it, and reads the dataset it left", async () => {
    const store = storeOf();
    const { api, updates } = fakePosthog(RAW);
    const lines: string[] = [];
    const result = await refreshDataset(
      { datasetId: "data-set", dryRun: false },
      {
        posthog: api,
        sources: sourcesOf(store),
        parseCurrent: parseEditStub,
        ...quiet,
        log: (line) => lines.push(line),
      },
    );
    expect(updates.map((update) => update.id)).toEqual(["item-a"]);
    expect(updates[0]!.body.base_version).toBe(1);
    expect(updates[0]!.body.metadata).toMatchObject({ snapshot_at: SNAPSHOT_AT });
    expect(lines).toEqual(["refreshed reel aaaaaaaa: no snapshot yet"]);
    expect(result.refreshed).toEqual(["aaaaaaaa"]);
    const [expected] = (await freshItems(store)) as { input: unknown; metadata: unknown }[];
    const [written] = result.dataset.items as { input: unknown; metadata: unknown }[];
    expect(written!.input).toEqual(expected!.input);
    expect(written!.metadata).toEqual(expected!.metadata);
  });

  it("a dry run prints what would change, writes nothing, and hands back the refreshed items in memory", async () => {
    const store = storeOf();
    const { api, updates } = fakePosthog(RAW);
    const lines: string[] = [];
    const result = await refreshDataset(
      { datasetId: "data-set", dryRun: true },
      {
        posthog: api,
        sources: sourcesOf(store),
        parseCurrent: parseEditStub,
        ...quiet,
        log: (line) => lines.push(line),
      },
    );
    expect(updates).toEqual([]);
    expect(lines).toEqual(["would refresh reel aaaaaaaa: no snapshot yet"]);
    expect(
      (result.dataset.items[0] as { metadata: { snapshot_at?: string } }).metadata.snapshot_at,
    ).toBe(SNAPSHOT_AT);
  });

  it("forced, it writes every selected reel even when fresh, narrowed to one reel by its id prefix", async () => {
    const store = storeOf();
    const other = ownerItemJson(
      "another reel with other words",
      {},
      { reelId: "cccccccc", id: "item-c" },
    );
    const { api, updates } = fakePosthog([...(await freshItems(store)), other]);
    const lines: string[] = [];
    await refreshDataset(
      { datasetId: "data-set", dryRun: false, reel: "aaaa", force: true },
      {
        posthog: api,
        sources: sourcesOf(store),
        parseCurrent: parseEditStub,
        ...quiet,
        log: (line) => lines.push(line),
      },
    );
    expect(updates.map((update) => update.id)).toEqual(["item-a"]);
    expect(lines[0]).toMatch(/^refreshed reel aaaaaaaa: forced; 1 curator runs \(\d+ picks\)/);
  });

  it("refuses an unknown reel", async () => {
    const store = storeOf();
    const { api } = fakePosthog(RAW);
    await expect(
      refreshDataset(
        { datasetId: "data-set", dryRun: true, reel: "dddd" },
        { posthog: api, sources: sourcesOf(store), ...quiet },
      ),
    ).rejects.toThrow("no labelled reel dddd");
  });

  it("names how far it got when a write fails, so the next run finishes it", async () => {
    const store = storeOf();
    const other = ownerItemJson(
      "another reel with other words",
      {},
      { reelId: "cccccccc", id: "item-c" },
    );
    const { api } = fakePosthog([...RAW, other], { failAt: 2 });
    await expect(
      refreshDataset(
        { datasetId: "data-set", dryRun: false },
        { posthog: api, sources: sourcesOf(store), parseCurrent: parseEditStub, ...quiet },
      ),
    ).rejects.toThrow("stopped after 1 of 2 reels, run the eval again to finish");
  });
});

describe("the eval reads what the refresh left", () => {
  // Every method but the dataset and the update throws: a judge dry run makes no other call.
  const noOtherCall = {
    async scorerVersion(): Promise<string> {
      throw new Error("no scorer expected");
    },
    async createExperiment(): Promise<void> {
      throw new Error("no experiment expected");
    },
    async upload(): Promise<void> {
      throw new Error("no upload expected");
    },
    async complete(): Promise<void> {},
    async fail(): Promise<void> {},
  };

  it("a judge dry run over a stale item refreshes it first and counts its runs", async () => {
    const store = storeOf();
    const { api, updates } = fakePosthog(RAW);
    const calls: AiRequest[] = [];
    const ai: AiRunner = {
      async call(request) {
        calls.push(request);
        return { kind: "answer", answer: {}, usage: NO_USAGE, exchange: {} as AiExchange };
      },
    };
    const posthog = await refreshedPosthog(
      { ...api, ...noOtherCall } as EvalsApi,
      { datasetId: "data-set", dryRun: true },
      { sources: sourcesOf(store), parseCurrent: parseEditStub, ...quiet, log: () => undefined },
    );
    const lines: string[] = [];
    await runJudgeEval(
      { datasetId: "data-set", dryRun: true },
      {
        posthog,
        prompts: fakePromptSource(),
        ai,
        telemetry: createTelemetry({}),
        saveReport: async () => "x",
        log: (line) => lines.push(line),
      },
    );
    expect(updates).toEqual([]);
    expect(calls).toEqual([]);
    expect(lines.some((line) => line.includes("1 labelled reels"))).toBe(true);
  });

  it("a real refresh writes the stale item before the eval, which then reads the new version", async () => {
    const store = storeOf();
    const { api, updates } = fakePosthog(RAW);
    const posthog = await refreshedPosthog(
      { ...api, ...noOtherCall } as EvalsApi,
      { datasetId: "data-set", dryRun: false },
      { sources: sourcesOf(store), parseCurrent: parseEditStub, ...quiet, log: () => undefined },
    );
    expect(updates).toHaveLength(1);
    const dataset = await posthog.dataset("data-set");
    expect(dataset.revision).toBe(8);
    expect((dataset.items[0] as { metadata: { snapshot_at?: string } }).metadata.snapshot_at).toBe(
      SNAPSHOT_AT,
    );
  });
});
