import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ErrorCapture,
  type ErrorProperties,
  DISABLED_CAPTURE,
  captureRequestError,
  cut,
  errorTrackingConfig,
  reportFailure,
  requestUserId,
  scrub,
  serverErrorCapture,
} from "./error-tracking";

// Anything that looks like a signed URL, a secret, a Bearer token or an email.
const LEAK =
  /https?:\/\/\S*\?(?!\[redacted\])|sb_secret_\w|Bearer (?!\[redacted\])|@[^ ]+\.[a-z]{2,}/;

function recordingCapture(options: { failFlush?: boolean } = {}) {
  const calls: { error: Error; distinctId: string | undefined; properties: ErrorProperties }[] = [];
  let flushes = 0;
  const capture: ErrorCapture = {
    capture(error, distinctId, properties) {
      calls.push({ error, distinctId, properties });
    },
    async flush() {
      flushes += 1;
      if (options.failFlush) throw new Error("flush failed");
    },
  };
  return { capture, calls, flushes: () => flushes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorTrackingConfig and serverErrorCapture", () => {
  it.each([
    { projectToken: undefined, host: "https://eu.i.posthog.com" },
    { projectToken: "token", host: undefined },
    { projectToken: "  ", host: "https://eu.i.posthog.com" },
    { projectToken: "token", host: " " },
  ])("is closed without both variables (%o) and builds no client", (env) => {
    expect(errorTrackingConfig(env)).toBeNull();
    const factory = vi.fn();
    const capture = serverErrorCapture(errorTrackingConfig(env), factory);
    expect(capture).toBe(DISABLED_CAPTURE);
    capture.capture(new Error("x"), undefined, {});
    expect(factory).not.toHaveBeenCalled();
  });

  it("builds a client on the first capture and shuts it down on flush", async () => {
    const client = { captureException: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const factory = vi.fn(() => client);
    const config = errorTrackingConfig({
      projectToken: " token ",
      host: "https://eu.i.posthog.com",
    });
    expect(config).toEqual({ projectToken: "token", host: "https://eu.i.posthog.com" });
    const capture = serverErrorCapture(config, factory);
    await capture.flush();
    expect(factory).not.toHaveBeenCalled();
    const error = new Error("studio: x");
    capture.capture(error, "user-1", { app: "studio" });
    expect(factory).toHaveBeenCalledWith("token", "https://eu.i.posthog.com");
    expect(client.captureException).toHaveBeenCalledWith(error, "user-1", { app: "studio" });
    await capture.flush();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it("never rejects when shutdown fails", async () => {
    const client = {
      captureException: vi.fn(),
      shutdown: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    const capture = serverErrorCapture({ projectToken: "t", host: "h" }, () => client);
    capture.capture(new Error("x"), undefined, {});
    await expect(capture.flush()).resolves.toBeUndefined();
  });
});

describe("scrub", () => {
  it("redacts a signed URL's query string", () => {
    expect(scrub("PUT https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=abc failed")).toBe(
      "PUT https://acc.r2.cloudflarestorage.com/b/k?[redacted] failed",
    );
  });

  it("redacts secret-prefixed tokens, Bearer tokens, JWTs and emails", () => {
    const out = scrub(
      "key sb_secret_aaaa auth Bearer abc.def jwt eyJhbGc.eyJzdWI.sig mail owner@example.com stripe sk_test_aaaa",
    );
    expect(out).toBe(
      "key [redacted] auth Bearer [redacted] jwt [redacted] mail [redacted] stripe [redacted]",
    );
  });

  it("truncates long input without splitting a surrogate pair", () => {
    expect(scrub("a".repeat(600))).toHaveLength(500);
    expect(scrub("ab", 1)).toBe("a");
    expect(cut("a\u{1F600}", 2)).toBe("a");
  });
});

describe("reportFailure", () => {
  it("captures one StudioFailure with the stable message, code and user, then flushes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rec = recordingCapture();
    const error = Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    await reportFailure(rec.capture, {
      message: "studio: multipart upload not created",
      error,
      userId: "user-1",
    });
    expect(rec.calls).toHaveLength(1);
    const [call] = rec.calls;
    expect(call!.error.message).toBe("studio: multipart upload not created");
    expect(call!.error.name).toBe("StudioFailure");
    expect(call!.error.cause).toBeUndefined();
    expect(call!.distinctId).toBe("user-1");
    expect(call!.properties).toEqual({
      app: "studio",
      error_code: "AccessDenied",
      error_message: "Access Denied",
    });
    expect(rec.flushes()).toBe(1);
    expect(log).toHaveBeenCalledWith(
      "studio: multipart upload not created:",
      "AccessDenied",
      "Access Denied",
    );
  });

  it("scrubs every string property", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rec = recordingCapture();
    await reportFailure(rec.capture, {
      message: "studio: preview not signed",
      error: new Error(
        "GET https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=abc sb_secret_aaaa Bearer zzz owner@example.com",
      ),
      properties: { reel_id: "r", note: "owner@example.com" },
    });
    for (const value of Object.values(rec.calls[0]!.properties)) {
      if (typeof value === "string") expect(value).not.toMatch(LEAK);
    }
  });
});

describe("captureRequestError", () => {
  it("captures the path without its query, the method and the route, then flushes", async () => {
    const rec = recordingCapture();
    const thrown = Object.assign(new Error("boom owner@example.com"), { digest: "123" });
    await captureRequestError(
      rec.capture,
      thrown,
      { path: "/studio/auth/confirm?token_hash=abc", method: "GET" },
      {
        routerKind: "App Router",
        routePath: "/auth/confirm",
        routeType: "route",
        renderSource: undefined,
      },
      "user-1",
    );
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.error.message).toBe("boom [redacted]");
    expect(rec.calls[0]!.distinctId).toBe("user-1");
    expect(rec.calls[0]!.properties).toEqual({
      app: "studio",
      path: "/studio/auth/confirm",
      method: "GET",
      route_path: "/auth/confirm",
      route_type: "route",
      router_kind: "App Router",
      render_source: null,
      digest: "123",
    });
    expect(rec.flushes()).toBe(1);
  });

  it("does not reject when the flush throws", async () => {
    const rec = recordingCapture({ failFlush: true });
    const capture: ErrorCapture = {
      capture: rec.capture.capture,
      flush: async () => {
        try {
          await rec.capture.flush();
        } catch {
          // serverErrorCapture swallows it the same way.
        }
      },
    };
    await expect(
      captureRequestError(
        capture,
        "thrown string",
        { path: "/studio", method: "GET" },
        { routerKind: "App Router", routePath: "/", routeType: "render" },
        undefined,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("requestUserId", () => {
  const config = { url: "http://127.0.0.1:54431", publishableKey: "key" };

  it("is undefined without a cookie header or config", async () => {
    const factory = vi.fn();
    expect(await requestUserId(undefined, config, factory)).toBeUndefined();
    expect(await requestUserId("a=b", null, factory)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("is undefined when the claims call throws", async () => {
    const factory = vi.fn(() => ({
      auth: {
        getClaims: async () => {
          throw new Error("bad cookie");
        },
      },
    }));
    expect(await requestUserId("sb-auth-token=x", config, factory)).toBeUndefined();
  });

  it("is the claims' sub", async () => {
    const factory = vi.fn(() => ({
      auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } } }) },
    }));
    expect(await requestUserId(["sb-auth-token=x"], config, factory)).toBe("user-1");
    expect(factory).toHaveBeenCalledWith(config, [{ name: "sb-auth-token", value: "x" }]);
  });
});
