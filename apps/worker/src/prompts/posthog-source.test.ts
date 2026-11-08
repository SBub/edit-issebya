import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { posthogPromptSource, promptUrl } from "./posthog-source.ts";
import { promptSourceOf } from "./select.ts";
import { PromptUnavailable } from "./source.ts";

const ENV = {
  POSTHOG_PERSONAL_API_KEY: "phx_test_personal",
  POSTHOG_PROJECT_ID: "312096",
  POSTHOG_HOST: "https://posthog.example.test",
};

const URL_OF_PROMPT =
  "https://posthog.example.test/api/projects/312096/llm_prompts/name/reel-hook/?label=production";

// The API's answer for one prompt version.
function served(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "test prompt reel-hook {{transcript}} {{style}}",
    name: "reel-hook",
    version: 2,
    label: "production",
    ...overrides,
  };
}

// Stubs fetch with one answer per call (a response or a thrown error). Records
// each call's URL and headers.
function answers(...replies: (Response | Error)[]) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    headers.push({ ...(init?.headers as Record<string, string>) });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? new Response("{}", { status: 500 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, urls, headers };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function failureOf(promise: Promise<unknown>): Promise<PromptUnavailable> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PromptUnavailable);
  return error as PromptUnavailable;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("promptUrl", () => {
  it("names the project's prompt by name, with the label as a query parameter and no token", () => {
    expect(promptUrl("https://posthog.example.test/", "312096", "reel-hook", "production")).toBe(
      URL_OF_PROMPT,
    );
  });
});

describe("the PostHog prompt source", () => {
  it("fetches the prompt by name at the label, with the personal key as a bearer token, and returns its identity", async () => {
    const { urls, headers } = answers(json(served()));
    const prompt = await posthogPromptSource(ENV).get("reel-hook");
    expect(prompt).toEqual({
      name: "reel-hook",
      version: 2,
      label: "production",
      text: "test prompt reel-hook {{transcript}} {{style}}",
    });
    expect(urls).toEqual([URL_OF_PROMPT]);
    expect(headers[0]?.Authorization).toBe("Bearer phx_test_personal");
  });

  it("uses POSTHOG_PROMPT_LABEL as the label, and defaults to production", async () => {
    const { urls } = answers(json(served({ label: "staging" })));
    await posthogPromptSource({ ...ENV, POSTHOG_PROMPT_LABEL: "staging" }).get("reel-hook");
    expect(urls[0]).toContain("?label=staging");
    expect(urls[0]).toContain("/llm_prompts/name/reel-hook/");
  });

  it("caches a fetched version for a few minutes, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fetch } = answers(json(served()), json(served({ version: 3 })));
    const source = posthogPromptSource(ENV);
    expect((await source.get("reel-hook")).version).toBe(2);
    expect((await source.get("reel-hook")).version).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 301_000);
    expect((await source.get("reel-hook")).version).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails as unavailable, naming the variable, when a setting is missing, without a request", async () => {
    const { fetch } = answers();
    for (const [missing, reason] of [
      ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PERSONAL_API_KEY is not set"],
      ["POSTHOG_PROJECT_ID", "POSTHOG_PROJECT_ID is not set"],
      ["POSTHOG_HOST", "POSTHOG_HOST is not set"],
    ] as const) {
      const env: Record<string, string | undefined> = { ...ENV, [missing]: "" };
      const error = await failureOf(posthogPromptSource(env).get("reel-hook"));
      expect(error.message).toBe(
        `prompts: reel-hook (label production) could not be fetched: ${reason}`,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails as unavailable, naming the prompt and label, when the prompt is not found (404)", async () => {
    answers(json({ detail: "Not found." }, 404));
    const error = await failureOf(posthogPromptSource(ENV).get("reel-hook"));
    expect(error.message).toBe(
      'prompts: reel-hook (label production) could not be fetched: prompt "reel-hook" label "production" not found',
    );
  });

  it("fails as unavailable, never naming the key, when the key may not read the prompts (403)", async () => {
    answers(json({ detail: "Forbidden." }, 403));
    const error = await failureOf(posthogPromptSource(ENV).get("reel-hook"));
    expect(error.message).toContain("llm_prompt:read");
    expect(error.message).not.toContain("phx_test_personal");
  });

  it("fails as unavailable when the label is not on the version the API serves", async () => {
    answers(json(served({ label: undefined })));
    const error = await failureOf(posthogPromptSource(ENV).get("reel-hook"));
    expect(error.message).toBe(
      "prompts: reel-hook (label production) could not be fetched: the label is not on version 2",
    );
  });

  it("serves a version with no config, since a prompt carries no temperature", async () => {
    answers(json(served()));
    const prompt = await posthogPromptSource(ENV).get("reel-hook");
    expect(prompt).toMatchObject({ version: 2, label: "production" });
    expect(prompt).not.toHaveProperty("temperature");
  });

  it("fails as unavailable, not as an outage, on a malformed answer", async () => {
    answers(json({ detail: "odd" }), json({ prompt: "x", name: "reel-hook" }));
    const log = vi.fn();
    const source = posthogPromptSource(ENV, log);
    await expect(source.get("reel-hook")).rejects.toThrow("has no prompt, name or version");
    await expect(source.get("reel-hook")).rejects.toThrow("has no prompt, name or version");
    expect(log).not.toHaveBeenCalled();
  });

  it("fails as unavailable when PostHog cannot be reached, never naming the key", async () => {
    answers(new TypeError("fetch failed"));
    const error = await failureOf(posthogPromptSource(ENV).get("reel-hook"));
    expect(error.message).toContain("fetch failed");
    expect(error.message).not.toContain("phx_test_personal");
  });

  it("treats a timed-out request as an outage", async () => {
    answers(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const error = await failureOf(posthogPromptSource(ENV).get("reel-hook"));
    expect(error.message).toContain("aborted due to timeout");
  });

  it("never reads a token setting, and sends none in the URL or the headers", async () => {
    const reads: string[] = [];
    const env = new Proxy<Record<string, string | undefined>>(
      {
        ...ENV,
        POSTHOG_PROJECT_TOKEN: "phc_test_events",
      },
      {
        get(target, key: string) {
          reads.push(key);
          return target[key];
        },
      },
    );
    const { urls, headers } = answers(json(served()));
    await posthogPromptSource(env).get("reel-hook");
    expect(reads.filter((key) => key.includes("TOKEN"))).toEqual([]);
    expect(urls[0]).not.toMatch(/token/i);
    expect(urls[0]).not.toContain("phc_");
    expect(JSON.stringify(headers)).not.toContain("phc_");
  });

  it("serves the last copy on a network error or a 5xx within 60 minutes, marked stale, with one warning line that names no text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const log = vi.fn();
    answers(json(served()), new TypeError("fetch failed"), json({ detail: "down" }, 503));
    const source = posthogPromptSource(ENV, log);
    await source.get("reel-hook");
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const stale = await source.get("reel-hook");
    expect(stale).toEqual({
      name: "reel-hook",
      version: 2,
      label: "production",
      text: "test prompt reel-hook {{transcript}} {{style}}",
      stale: true,
    });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await source.get("reel-hook")).stale).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toBe(
      "prompts: reel-hook@v2 served from the last copy, fetched 6 minutes ago; PostHog did not answer",
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain("test prompt");
  });

  it("serves the last copy on a 429 as an outage", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const log = vi.fn();
    answers(json(served()), json({ detail: "slow down" }, 429));
    const source = posthogPromptSource(ENV, log);
    await source.get("reel-hook");
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await source.get("reel-hook")).stale).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("refuses the last copy once it is more than 60 minutes old since its fetch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const log = vi.fn();
    answers(json(served()), new TypeError("fetch failed"));
    const source = posthogPromptSource(ENV, log);
    await source.get("reel-hook");
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const error = await failureOf(source.get("reel-hook"));
    expect(error.message).toBe(
      "prompts: reel-hook (label production) could not be fetched: PostHog did not answer, and the copy of version 2 is older than 60 minutes",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("uses the copy at 59 minutes and not beyond the limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    answers(json(served()), new TypeError("fetch failed"));
    const source = posthogPromptSource(ENV, vi.fn());
    await source.get("reel-hook");
    vi.setSystemTime(Date.now() + 59 * 60_000);
    expect((await source.get("reel-hook")).stale).toBe(true);
  });

  it("fails a prompt never fetched in this process when PostHog does not answer", async () => {
    answers(new TypeError("fetch failed"));
    const log = vi.fn();
    const error = await failureOf(posthogPromptSource(ENV, log).get("reel-hook"));
    expect(error.message).toBe(
      "prompts: reel-hook (label production) could not be fetched: fetch failed",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("fails a 404 even with a copy held, and drops the copy so a later outage does not serve it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    answers(json(served()), json({ detail: "Not found." }, 404), new TypeError("fetch failed"));
    const log = vi.fn();
    const source = posthogPromptSource(ENV, log);
    await source.get("reel-hook");
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await expect(source.get("reel-hook")).rejects.toThrow(
      'prompt "reel-hook" label "production" not found',
    );
    await expect(source.get("reel-hook")).rejects.toThrow("could not be fetched: fetch failed");
    expect(log).not.toHaveBeenCalled();
  });

  it("fails a label that moved, even with a copy held", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    answers(json(served()), json(served({ label: undefined })));
    const source = posthogPromptSource(ENV, vi.fn());
    await source.get("reel-hook");
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await expect(source.get("reel-hook")).rejects.toThrow(
      "could not be fetched: the label is not on version 2",
    );
  });
});

describe("promptSourceOf", () => {
  it("is the placeholder source under E2E_MOCK_PROMPTS=true", async () => {
    const prompt = await promptSourceOf({ E2E_MOCK_PROMPTS: "true" }).get("reel-hook");
    expect(prompt).toEqual(await fakePromptSource().get("reel-hook"));
  });

  it("is PostHog otherwise, so a missing key fails the fetch", async () => {
    const env = { E2E_MOCK_PROMPTS: "1" };
    await expect(promptSourceOf(env).get("reel-hook")).rejects.toThrow(
      "POSTHOG_PERSONAL_API_KEY is not set",
    );
  });
});
