import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DISABLED_TRACKER,
  createErrorTracker,
  installCrashCapture,
  lastChars,
} from "./error-tracking.ts";
import { FootageRefused } from "./failure.ts";
import { TEST_JOB } from "./recording-steps.ts";

// A signed R2 URL, in two parts so no literal looks like a secret.
const R2_OBJECT = "https://x.r2.cloudflarestorage.com/k";
const SIGNED_URL = `${R2_OBJECT}?X-Amz-Signature=abc`;

const ENV = { POSTHOG_PROJECT_TOKEN: "token", POSTHOG_HOST: "https://eu.i.posthog.com" };

function fakeClient() {
  return {
    captureException: vi.fn(),
    shutdown: vi.fn<(timeoutMs?: number) => Promise<void>>(async () => undefined),
  };
}

function step(error: unknown, tail = "boom") {
  return { job: TEST_JOB, step: "transcribe", attempt: 1, retrying: false, error, tail };
}

describe("createErrorTracker", () => {
  it.each([
    {},
    { POSTHOG_PROJECT_TOKEN: "token" },
    { POSTHOG_HOST: "https://eu.i.posthog.com" },
    { POSTHOG_PROJECT_TOKEN: " ", POSTHOG_HOST: "https://eu.i.posthog.com" },
  ])("builds no client without both variables (%o), every method a no-op", async (env) => {
    const factory = vi.fn();
    const tracker = createErrorTracker(env, factory);
    expect(tracker).toBe(DISABLED_TRACKER);
    expect(tracker.enabled).toBe(false);
    tracker.stepFailed(step(new Error("x")));
    tracker.crashed(new Error("x"));
    await expect(tracker.shutdown()).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("captures a failed step once with the job's owner and its properties", () => {
    const client = fakeClient();
    const tracker = createErrorTracker(ENV, () => client);
    const error = Object.assign(new Error("transcribe exited with 1"), {
      cause: Object.assign(new Error("inner"), { code: "ENOENT" }),
    });
    tracker.stepFailed({ ...step(error, "x".repeat(1500)), request: "never" } as never);
    expect(client.captureException).toHaveBeenCalledOnce();
    const [captured, distinctId, properties] = client.captureException.mock.calls[0]!;
    expect((captured as Error).message).toBe("worker: step failed");
    expect((captured as Error).cause).toBeUndefined();
    expect(distinctId).toBe(TEST_JOB.owner_id);
    expect(properties).toEqual({
      app: "worker",
      step: "transcribe",
      job_kind: "process",
      reel_id: TEST_JOB.reel_id,
      job_id: TEST_JOB.id,
      attempt: 1,
      retrying: false,
      failure_kind: "failed",
      error_code: "ENOENT",
      error_tail: "x".repeat(1000),
    });
  });

  it("scrubs a signed URL and a secret from the tail", () => {
    const client = fakeClient();
    const tracker = createErrorTracker(ENV, () => client);
    tracker.stepFailed(step(new Error("x"), `GET ${SIGNED_URL} failed with sb_secret_x`));
    const tail = client.captureException.mock.calls[0]![2].error_tail as string;
    expect(tail).toBe(`GET ${R2_OBJECT}?[redacted] failed with [redacted]`);
  });

  it("marks a refusal refused and a transient error transient", () => {
    const client = fakeClient();
    const tracker = createErrorTracker(ENV, () => client);
    tracker.stepFailed(step(new FootageRefused("not vertical")));
    tracker.stepFailed(step(Object.assign(new Error("reset"), { code: "ECONNRESET" })));
    expect(client.captureException.mock.calls.map((call) => call[2].failure_kind)).toEqual([
      "refused",
      "transient",
    ]);
    expect(client.captureException.mock.calls[0]![2].error_code).toBe("FootageRefused");
  });

  it("captures a crash under the worker's id, scrubbed", () => {
    const client = fakeClient();
    const tracker = createErrorTracker({ ...ENV, WORKER_ID: "mac" }, () => client);
    tracker.crashed(new TypeError("bad owner@example.com"));
    const [captured, distinctId, properties] = client.captureException.mock.calls[0]!;
    expect((captured as Error).message).toBe("bad [redacted]");
    expect((captured as Error).name).toBe("TypeError");
    expect(distinctId).toBe("worker:mac");
    expect(properties).toEqual({ app: "worker", kind: "uncaught" });
  });

  it("never rejects on shutdown when PostHog fails", async () => {
    const client = fakeClient();
    client.shutdown.mockRejectedValue(new Error("down"));
    await expect(createErrorTracker(ENV, () => client).shutdown(10)).resolves.toBeUndefined();
  });
});

describe("lastChars", () => {
  it("never starts on half a surrogate pair", () => {
    expect(lastChars("\u{1F600}ab", 3)).toBe("ab");
    expect(lastChars("abc", 5)).toBe("abc");
  });
});

describe("installCrashCapture", () => {
  it("captures an uncaught exception, flushes, then exits with 1", async () => {
    const client = fakeClient();
    const tracker = createErrorTracker(ENV, () => client);
    const proc = new EventEmitter();
    const exit = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installCrashCapture(tracker, proc as unknown as NodeJS.Process, exit);
    proc.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(client.captureException).toHaveBeenCalledOnce();
    expect(client.shutdown).toHaveBeenCalledWith(3000);
    expect(client.shutdown.mock.invocationCallOrder[0]!).toBeLessThan(
      exit.mock.invocationCallOrder[0]!,
    );
  });
});
