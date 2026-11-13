import { describe, expect, it } from "vitest";
import { type ExperimentBody, type UploadBody, posthogEvals } from "./posthog-evals.ts";

const ENV = {
  POSTHOG_PERSONAL_API_KEY: "phx_test_key",
  POSTHOG_PROJECT_ID: "42",
  POSTHOG_HOST: "https://posthog.test/",
};
const BASE = "https://posthog.test/api/projects/42";

interface Seen {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

// A PostHog that answers each request from `answer` and records it.
function server(answer: (seen: Seen) => { status?: number; body?: unknown }) {
  const requests: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("Authorization"),
    };
    requests.push(seen);
    const { status = 200, body = {} } = answer(seen);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { requests, api: posthogEvals(ENV, fetchFn) };
}

describe("the dataset", () => {
  it("reads the latest revision and its items, an item without content read alone", async () => {
    const full = { id: "i1", input: { a: 1 }, expected_output: { b: 2 } };
    const { requests, api } = server(({ url }) => {
      if (url.includes("/revisions/")) {
        return {
          body: {
            results: [
              { id: "rev-6", revision: 6 },
              { id: "rev-5", revision: 5 },
            ],
          },
        };
      }
      if (url.includes("/dataset_items/i2/")) return { body: { ...full, id: "i2" } };
      return { body: { results: [full, { id: "i2" }] } };
    });
    expect(await api.dataset("data-set")).toEqual({
      revisionId: "rev-6",
      revision: 6,
      items: [full, { ...full, id: "i2" }],
    });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE}/datasets/data-set/revisions/?limit=1&offset=0`,
      `GET ${BASE}/dataset_items/?dataset=data-set&revision=6&archived=false&limit=25&offset=0`,
      `GET ${BASE}/dataset_items/i2/?revision=6`,
    ]);
    expect(requests.every((request) => request.authorization === "Bearer phx_test_key")).toBe(true);
  });

  it("reads every page of items", async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, at) => ({
        id: `i${from + at}`,
        input: {},
        expected_output: {},
      }));
    const { requests, api } = server(({ url }) => {
      if (url.includes("/revisions/")) return { body: { results: [{ id: "rev", revision: 1 }] } };
      return { body: { results: url.includes("offset=0") ? page(0, 25) : page(25, 3) } };
    });
    expect((await api.dataset("d")).items).toHaveLength(28);
    expect(requests.at(-1)?.url).toContain("offset=25");
  });

  it("names the scope the key lacks, and never the key", async () => {
    const { api } = server(() => ({ status: 403, body: { detail: "permission_denied" } }));
    const failure = await api.dataset("d").catch((error: Error) => error.message);
    expect(failure).toBe(
      "evals: access denied while reading the dataset's revisions: POSTHOG_PERSONAL_API_KEY needs the dataset:read scope and project 42",
    );
    expect(failure).not.toContain("phx_test_key");
  });

  it("fails on a dataset with no revision, and on a missing variable before any request", async () => {
    const { api } = server(() => ({ body: { results: [] } }));
    await expect(api.dataset("d")).rejects.toThrow("evals: dataset d has no revision");
    const none = posthogEvals({ POSTHOG_HOST: "https://posthog.test" }, (() => {
      throw new Error("no request expected");
    }) as typeof fetch);
    await expect(none.dataset("d")).rejects.toThrow(
      "evals: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID is not set",
    );
  });
});

describe("the scorer", () => {
  it("uses the existing numeric scorer of that exact name", async () => {
    const { requests, api } = server(() => ({
      body: {
        results: [
          { name: "judge_agreement_old", kind: "numeric", current_version_id: "old" },
          { name: "judge_agreement", kind: "numeric", current_version_id: "scorer-v1" },
        ],
      },
    }));
    expect(await api.scorerVersion("judge_agreement", "what it is")).toBe("scorer-v1");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE}/llm_analytics/score_definitions/?${new URLSearchParams({ search: "judge_agreement", archived: "false", limit: "100", offset: "0" })}`,
    ]);
  });

  it("makes it once when missing: numeric, 0 to 1", async () => {
    const { requests, api } = server(({ method }) =>
      method === "GET" ? { body: { results: [] } } : { body: { current_version_id: "new-v1" } },
    );
    expect(await api.scorerVersion("judge_agreement", "what it is")).toBe("new-v1");
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: `${BASE}/llm_analytics/score_definitions/`,
      body: {
        name: "judge_agreement",
        description: "what it is",
        kind: "numeric",
        config: { min: 0, max: 1 },
      },
    });
  });

  it("names the write scope when the key cannot make it", async () => {
    const { api } = server(({ method }) =>
      method === "GET" ? { body: { results: [] } } : { status: 403 },
    );
    await expect(api.scorerVersion("judge_agreement", "")).rejects.toThrow(
      /creating the judge_agreement scorer: POSTHOG_PERSONAL_API_KEY needs the llm_analytics:write scope/,
    );
  });
});

describe("the offline experiment", () => {
  it("is created, uploaded to, then completed or failed, by its caller's id", async () => {
    const { requests, api } = server(() => ({ body: {} }));
    const experiment = { id: "exp-1", name: "a run" } as ExperimentBody;
    const upload = { items: [], results: [] } as UploadBody;
    await api.createExperiment(experiment);
    await api.upload("exp-1", upload);
    await api.complete("exp-1");
    await api.fail("exp-1");
    const root = `${BASE}/ai_observability/offline_experiments/`;
    expect(requests.map(({ method, url, body }) => [method, url, body])).toEqual([
      ["POST", root, experiment],
      ["POST", `${root}exp-1/upload/`, upload],
      ["POST", `${root}exp-1/complete/`, {}],
      ["POST", `${root}exp-1/fail/`, {}],
    ]);
  });

  it("names the ingestion scope on a refusal, and shows PostHog's reason on a bad request", async () => {
    const denied = server(() => ({ status: 403 }));
    await expect(denied.api.createExperiment({} as ExperimentBody)).rejects.toThrow(
      /needs the offline_evaluation_ingestion:write scope/,
    );
    const bad = server(() => ({
      status: 400,
      body: { detail: "dataset_item_version_id invalid" },
    }));
    await expect(bad.api.upload("exp-1", {} as UploadBody)).rejects.toThrow(
      /HTTP 400 while uploading the results: .*dataset_item_version_id invalid/,
    );
  });
});

describe("the snapshot's item update", () => {
  it("sends a PATCH with the base version, the replacement input and metadata, and the scope it needs", async () => {
    const { requests, api } = server(() => ({ body: { id: "i1", version: 2 } }));
    await api.updateItem("i 1", {
      base_version: 1,
      input: { transcript: { words: [] }, curator_input: { status: "skipped", reason: "x" } },
      metadata: { reel_id: "r", past_curator_runs: [] },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      url: `${BASE}/dataset_items/i%201/`,
      body: {
        base_version: 1,
        input: { transcript: { words: [] }, curator_input: { status: "skipped", reason: "x" } },
        metadata: { reel_id: "r", past_curator_runs: [] },
      },
    });
  });

  it("names the dataset:write scope when PostHog refuses the key", async () => {
    const { api } = server(() => ({ status: 403, body: {} }));
    await expect(
      api.updateItem("i1", { base_version: 1, input: {}, metadata: {} }),
    ).rejects.toThrow("needs the dataset:write scope");
  });
});
