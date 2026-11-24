import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { ownerItemJson } from "./eval-fixtures.ts";
import { snapshotItems } from "./snapshot-fixtures.ts";
import { fakePromptSource } from "./fake-prompts.ts";
import {
  ANSWER,
  OWNER,
  TEXT,
  answerResult,
  fixtureSources,
  noMeasurer,
  parseEditStub,
  roleAi,
} from "./curator-fixtures.ts";
import type { AiResult } from "../src/ai.ts";
import { createTelemetry } from "../src/telemetry.ts";
import type { EvalsApi, ExperimentBody, UploadBody } from "../src/evals/posthog-evals.ts";
import type { CuratorEvalDeps, CuratorEvalOptions } from "../src/evals/run-curator.ts";
import type { CuratorSources } from "../src/evals/curator-input.ts";

// THE CURATOR EVAL'S TEST SETUP: the eval's dependencies as in-memory fakes,
// shared by the curator's tests and the comparison's.

// The answer the curator gives: the owner's accent and big word.
export const CURATOR_ANSWER = {
  ...ANSWER,
  lists: [],
  visuals: [{ from: "w1", to: "w1", description: "a desk" }],
};

// The curator answers `CURATOR_ANSWER`.
export function reply(): AiResult {
  return answerResult(CURATOR_ANSWER);
}

// The dataset as the refresh step leaves it for the reels `sources` holds.
const RAW_ITEMS = [ownerItemJson(TEXT, OWNER)];
const DATASET = { revisionId: "revision-6", revision: 6 };

export function setup({
  ai = roleAi(reply),
  sources = fixtureSources(),
  overrides = {},
}: {
  ai?: ReturnType<typeof roleAi>;
  sources?: CuratorSources;
  overrides?: Partial<EvalsApi>;
} = {}) {
  const posthogCalls: string[] = [];
  const sent: { experiment?: ExperimentBody; upload?: UploadBody } = {};
  const posthog: EvalsApi = {
    async dataset() {
      posthogCalls.push("dataset");
      return {
        ...DATASET,
        items: await snapshotItems(RAW_ITEMS, sources, { parseCurrent: parseEditStub }),
      };
    },
    async updateItem() {
      throw new Error("the curator eval writes no dataset item");
    },
    async scorerVersion(name) {
      posthogCalls.push(`scorer ${name}`);
      return `${name}-version`;
    },
    async createExperiment(body) {
      posthogCalls.push("create");
      sent.experiment = body;
    },
    async upload(id, body) {
      posthogCalls.push(`upload ${id}`);
      sent.upload = body;
    },
    async complete(id) {
      posthogCalls.push(`complete ${id}`);
    },
    async fail(id) {
      posthogCalls.push(`fail ${id}`);
    },
    ...overrides,
  };
  const exporter = new InMemorySpanExporter();
  const lines: string[] = [];
  const reports: string[] = [];
  let ids = 0;
  const deps: CuratorEvalDeps = {
    posthog,
    curatorPrompts: fakePromptSource(),
    ai,
    telemetry: createTelemetry({}, { spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
    measurerOf: noMeasurer,
    parseCurrent: parseEditStub,
    validatorOf: () => () => ({ ok: true }),
    async saveReport(name, html) {
      reports.push(html);
      return `/out/${name}`;
    },
    log: (line) => lines.push(line),
    now: () => new Date("2026-11-12T10:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-00000000000${(ids += 1)}`,
  };
  return { deps, posthogCalls, sent, ai, lines, reports };
}

export const OPTIONS: CuratorEvalOptions = { datasetId: "data-set", dryRun: false, repeats: 1 };
