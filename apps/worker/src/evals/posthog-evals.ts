// POSTHOG'S EVALS API as the eval uses it: the hand-labelled dataset (read),
// the scorer (found, or made once), and the offline experiment a run is
// uploaded as. Same key, project and host as the prompts
// (`../prompts/posthog-source.ts`): POSTHOG_PERSONAL_API_KEY as a bearer token,
// POSTHOG_PROJECT_ID, POSTHOG_HOST. An error never carries the key.

type Env = Record<string, string | undefined>;

const REQUEST_TIMEOUT_MS = 30_000;
// PostHog's page limit for dataset items.
const ITEMS_PAGE = 25;

// The scope of the personal API key each request needs; a 403 names it.
const SCOPES = {
  dataset: "dataset:read",
  scorerRead: "llm_analytics:read",
  scorerWrite: "llm_analytics:write",
  experiment: "offline_evaluation_ingestion:write",
} as const;

export interface Dataset {
  // The latest revision: its uuid (what an experiment pins) and its number.
  revisionId: string;
  revision: number;
  // The items of that revision, as PostHog serves them.
  items: unknown[];
}

// The experiment's fields, PostHog's own names (the request body as sent).
export interface ExperimentBody {
  id: string;
  name: string;
  started_at: string;
  run_source: "local";
  suite_key: string;
  dataset_revision_id: string;
  expected_item_count: number;
  expected_result_count: number;
  model_version: string;
  prompt_version: string;
  application_version: string;
}

export interface UploadBody {
  items: {
    id: string;
    case_key: string;
    dataset_item_version_id: string;
    payload: {
      input: unknown;
      output: unknown;
      expected_output: unknown;
      metadata: Record<string, unknown>;
    };
  }[];
  results: {
    item_id: string;
    scorer_version_id: string;
    status: "ok" | "error" | "skipped";
    value?: number;
    error_code?: string;
    evaluator_trace_id: string;
    evaluated_at: string;
    payload: {
      reasoning?: string;
      error_message?: string;
      metadata: Record<string, unknown>;
    };
  }[];
}

export interface EvalsApi {
  dataset(datasetId: string): Promise<Dataset>;
  // The pinned version uuid of the numeric 0 to 1 scorer of this name, made when missing.
  scorerVersion(name: string, description: string): Promise<string>;
  createExperiment(body: ExperimentBody): Promise<void>;
  upload(experimentId: string, body: UploadBody): Promise<void>;
  complete(experimentId: string): Promise<void>;
  fail(experimentId: string): Promise<void>;
}

interface Call {
  method: "GET" | "POST";
  path: string;
  params?: Record<string, string>;
  body?: unknown;
  scope: string;
  what: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function rows(value: unknown): Record<string, unknown>[] {
  const results = record(value).results;
  return Array.isArray(results) ? results.map(record) : [];
}

export function posthogEvals(env: Env = process.env, fetchFn: typeof fetch = fetch): EvalsApi {
  const personalApiKey = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  const host = env.POSTHOG_HOST?.trim().replace(/\/+$/, "");

  async function request(call: Call): Promise<unknown> {
    const missing = [
      ["POSTHOG_PERSONAL_API_KEY", personalApiKey],
      ["POSTHOG_PROJECT_ID", projectId],
      ["POSTHOG_HOST", host],
    ].flatMap(([name, value]) => (value ? [] : [name]));
    if (missing.length > 0) throw new Error(`evals: ${missing.join(", ")} is not set`);
    const url = new URL(`${host}/api/projects/${encodeURIComponent(projectId!)}/${call.path}`);
    for (const [name, value] of Object.entries(call.params ?? {})) {
      url.searchParams.set(name, value);
    }
    const response = await fetchFn(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${personalApiKey}`,
        Accept: "application/json",
        ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status === 401) {
      throw new Error(`evals: PostHog refused POSTHOG_PERSONAL_API_KEY while ${call.what}`);
    }
    if (response.status === 403) {
      throw new Error(
        `evals: access denied while ${call.what}: POSTHOG_PERSONAL_API_KEY needs the ${call.scope} scope and project ${projectId}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `evals: PostHog answered HTTP ${response.status} while ${call.what}: ${text.slice(0, 400)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`evals: PostHog's answer is not JSON while ${call.what}`);
    }
  }

  const experiments = "ai_observability/offline_experiments/";
  const experiment = (path: string, body: unknown, what: string) =>
    request({ method: "POST", path, body, scope: SCOPES.experiment, what });

  return {
    async dataset(datasetId) {
      const id = encodeURIComponent(datasetId);
      // Newest first: the first row is the latest revision.
      const latest = rows(
        await request({
          method: "GET",
          path: `datasets/${id}/revisions/`,
          params: { limit: "1", offset: "0" },
          scope: SCOPES.dataset,
          what: "reading the dataset's revisions",
        }),
      )[0];
      if (typeof latest?.id !== "string" || typeof latest.revision !== "number") {
        throw new Error(`evals: dataset ${datasetId} has no revision`);
      }
      const revision = String(latest.revision);
      const listed: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += ITEMS_PAGE) {
        const page = rows(
          await request({
            method: "GET",
            path: "dataset_items/",
            params: {
              dataset: datasetId,
              revision,
              archived: "false",
              limit: String(ITEMS_PAGE),
              offset: String(offset),
            },
            scope: SCOPES.dataset,
            what: "reading the dataset's items",
          }),
        );
        listed.push(...page);
        if (page.length < ITEMS_PAGE) break;
      }
      // A list row may come without its content: then the item is read alone.
      const items: unknown[] = [];
      for (const row of listed) {
        items.push(
          row.input !== undefined && row.expected_output !== undefined
            ? row
            : await request({
                method: "GET",
                path: `dataset_items/${encodeURIComponent(String(row.id))}/`,
                params: { revision },
                scope: SCOPES.dataset,
                what: "reading a dataset item",
              }),
        );
      }
      return { revisionId: latest.id, revision: latest.revision, items };
    },

    async scorerVersion(name, description) {
      const found = rows(
        await request({
          method: "GET",
          path: "llm_analytics/score_definitions/",
          params: { search: name, archived: "false", limit: "100", offset: "0" },
          scope: SCOPES.scorerRead,
          what: `looking for the ${name} scorer`,
        }),
      ).find((row) => row.name === name && row.kind === "numeric");
      const scorer =
        found ??
        record(
          await request({
            method: "POST",
            path: "llm_analytics/score_definitions/",
            body: { name, description, kind: "numeric", config: { min: 0, max: 1 } },
            scope: SCOPES.scorerWrite,
            what: `creating the ${name} scorer`,
          }),
        );
      if (typeof scorer.current_version_id !== "string") {
        throw new Error(`evals: the ${name} scorer has no current version`);
      }
      return scorer.current_version_id;
    },

    async createExperiment(body) {
      await experiment(experiments, body, "creating the offline experiment");
    },
    async upload(experimentId, body) {
      await experiment(`${experiments}${experimentId}/upload/`, body, "uploading the results");
    },
    async complete(experimentId) {
      await experiment(`${experiments}${experimentId}/complete/`, {}, "completing the experiment");
    },
    async fail(experimentId) {
      await experiment(`${experiments}${experimentId}/fail/`, {}, "failing the experiment");
    },
  };
}
