import {
  type PromptSource,
  type PromptText,
  PromptUnavailable,
  promptIdentity,
  promptLabel,
} from "./source.ts";

type Env = Record<string, string | undefined>;

// How long a fetched version is served without asking PostHog again.
const FRESH_MS = 300_000;
// How long a copy may still run after its fetch, while PostHog does not answer.
const STALE_LIMIT_MS = 3_600_000;
// How long one request may take, the body included.
const REQUEST_TIMEOUT_MS = 10_000;

// One copy this process fetched: the version as PostHog served it, and when.
interface Copy {
  prompt: PromptText;
  fetchedAt: number;
}

// The fields of PostHog's answer the worker reads (the prompt's get-by-name
// endpoint; app_docs/decide-step.md, "Prompts").
interface Served {
  prompt: string;
  name: string;
  version: number;
  label?: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The answer's body when it is a prompt: the text and the version are strings
// and numbers; the label and the config may be absent. Anything else is a
// malformed answer.
function parseServed(body: unknown): Served | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.prompt !== "string") return null;
  if (typeof record.name !== "string") return null;
  if (typeof record.version !== "number") return null;
  if (record.label !== undefined && typeof record.label !== "string") return null;
  return record as unknown as Served;
}

// The request for one prompt by name at a label: the project's path, the label
// as a query parameter and the personal key as a bearer token. No token goes in
// the URL, so nothing the URL carries can reach a log or an error.
export function promptUrl(host: string, projectId: string, name: string, label: string): string {
  const base = host.replace(/\/+$/, "");
  return `${base}/api/projects/${encodeURIComponent(projectId)}/llm_prompts/name/${encodeURIComponent(name)}/?label=${encodeURIComponent(label)}`;
}

// Asks PostHog once. Resolves with the status and the body text; rejects when
// the request fails or times out (an outage, see below).
async function ask(
  url: string,
  personalApiKey: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${personalApiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

// The PostHog prompt source: each prompt fetched by name at the label
// (POSTHOG_PROMPT_LABEL) from the project (POSTHOG_PROJECT_ID) on the host
// (POSTHOG_HOST), with the personal API key (POSTHOG_PERSONAL_API_KEY) as a
// bearer token. No project token is read or sent: the worker reads no
// POSTHOG_PROJECT_TOKEN and no other token. Nothing is read at construction:
// a missing variable fails the fetch that needs it, with its name in the
// reason. The reason never carries a key.
//
// Freshness: a copy fetched within five minutes is served from memory. A copy
// older than that is fetched again. When PostHog does not answer (an outage: a
// network error, a timeout, a 5xx or a 429), the last copy this process fetched
// is served for at most an hour after its fetch, with one warning line (name,
// version, age; never the text). A copy never fetched fails. A 404, a 403, a
// missing label or a malformed answer is not an outage: it fails and drops the
// copy, so a deleted or relabelled prompt stops running at once.
export function posthogPromptSource(
  env: Env = process.env,
  log: (line: string) => void = console.warn,
): PromptSource {
  const label = promptLabel(env);
  const personalApiKey = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  const host = env.POSTHOG_HOST?.trim();
  const copies = new Map<string, Copy>();
  return {
    async get(name) {
      const fail = (reason: string) => new PromptUnavailable(name, label, reason);
      if (!personalApiKey) throw fail("POSTHOG_PERSONAL_API_KEY is not set");
      if (!projectId) throw fail("POSTHOG_PROJECT_ID is not set");
      if (!host) throw fail("POSTHOG_HOST is not set");
      const held = copies.get(name);
      if (held && Date.now() - held.fetchedAt < FRESH_MS) return held.prompt;

      // An outage keeps serving the held copy (or fails when there is none).
      const outage = (reason: string): PromptText => {
        if (!held) throw fail(reason);
        const age = Date.now() - held.fetchedAt;
        if (age > STALE_LIMIT_MS) {
          copies.delete(name);
          throw fail(
            `PostHog did not answer, and the copy of version ${held.prompt.version} is older than 60 minutes`,
          );
        }
        log(
          `prompts: ${promptIdentity(held.prompt)} served from the last copy, fetched ${Math.floor(age / 60_000)} minutes ago; PostHog did not answer`,
        );
        return { ...held.prompt, stale: true };
      };

      // Anything else fails at once and drops the copy.
      const refuse = (reason: string): never => {
        copies.delete(name);
        throw fail(reason);
      };

      let reply: { ok: boolean; status: number; text: string };
      try {
        reply = await ask(promptUrl(host, projectId, name, label), personalApiKey);
      } catch (error) {
        return outage(reasonOf(error));
      }
      if (reply.status === 429 || reply.status >= 500) {
        return outage(`PostHog answered HTTP ${reply.status}`);
      }
      if (!reply.ok) {
        if (reply.status === 404) {
          return refuse(`prompt "${name}" label "${label}" not found`);
        }
        if (reply.status === 403) {
          return refuse(
            "access denied: check that POSTHOG_PERSONAL_API_KEY has the llm_prompt:read scope and this project",
          );
        }
        return refuse(`PostHog answered HTTP ${reply.status}`);
      }

      let body: unknown;
      try {
        body = JSON.parse(reply.text);
      } catch {
        return refuse("PostHog's answer is not JSON");
      }
      const served = parseServed(body);
      if (!served) return refuse("PostHog's answer has no prompt, name or version");
      if (served.label !== label) {
        return refuse(`the label is not on version ${served.version}`);
      }
      const prompt: PromptText = {
        name,
        version: served.version,
        label,
        text: served.prompt,
      };
      copies.set(name, { prompt, fetchedAt: Date.now() });
      return prompt;
    },
  };
}
