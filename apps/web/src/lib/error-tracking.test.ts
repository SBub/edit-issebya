import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ErrorCapture,
  type ErrorProperties,
  DISABLED_CAPTURE,
  captureRequestError,
  errorTrackingConfig,
  reportFailure,
  scrub,
  serverErrorCapture,
} from "./error-tracking";

const LEAK =
  /https?:\/\/\S*\?(?!\[redacted\])|sk_test_\w|whsec_\w|sb_secret_\w|Bearer (?!\[redacted\])|@[^ ]+\.[a-z]{2,}/;
const HOST = "https://eu.i.posthog.com";

function recordingCapture() {
  const calls: { error: Error; distinctId: string | undefined; properties: ErrorProperties }[] = [];
  let flushes = 0;
  const capture: ErrorCapture = {
    capture(error, distinctId, properties) {
      calls.push({ error, distinctId, properties });
    },
    async flush() {
      flushes += 1;
    },
  };
  return { capture, calls, flushes: () => flushes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorTrackingConfig", () => {
  it.each([
    { vercelEnv: "preview", projectToken: "token", host: HOST },
    { vercelEnv: "development", projectToken: "token", host: HOST },
    { vercelEnv: undefined, projectToken: "token", host: HOST },
    { vercelEnv: "production", projectToken: "", host: HOST },
    { vercelEnv: "production", projectToken: "token", host: " " },
  ])("is closed outside production or without both variables (%o)", (env) => {
    expect(errorTrackingConfig(env)).toBeNull();
    const factory = vi.fn();
    expect(serverErrorCapture(errorTrackingConfig(env), factory)).toBe(DISABLED_CAPTURE);
    expect(factory).not.toHaveBeenCalled();
  });

  it("is open in production with both variables", () => {
    expect(errorTrackingConfig({ vercelEnv: "production", projectToken: "t", host: HOST })).toEqual(
      { projectToken: "t", host: HOST },
    );
  });
});

describe("reportFailure", () => {
  it("captures one anonymous WebFailure with app: web and the Stripe code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rec = recordingCapture();
    const error = Object.assign(new Error("Your card was declined. buyer@example.com"), {
      type: "StripeCardError",
      code: "card_declined",
    });
    await reportFailure(rec.capture, {
      message: "startCheckout: creating the Checkout Session failed",
      error,
    });
    expect(rec.calls).toHaveLength(1);
    const [call] = rec.calls;
    expect(call!.error.name).toBe("WebFailure");
    expect(call!.error.message).toBe("startCheckout: creating the Checkout Session failed");
    expect(call!.error.cause).toBeUndefined();
    expect(call!.distinctId).toBeUndefined();
    expect(call!.properties).toEqual({
      app: "web",
      error_code: "card_declined",
      error_message: "Your card was declined. [redacted]",
    });
    expect(rec.flushes()).toBe(1);
  });

  it("scrubs Stripe keys, webhook secrets, signed URLs and emails from every property", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rec = recordingCapture();
    await reportFailure(rec.capture, {
      message: "stripe webhook: sending failed",
      error: new Error(
        "sk_test_aaaa whsec_aaaa https://api.stripe.com/v1/x?key=abc Bearer zzz buyer@example.com",
      ),
      properties: { missing_config: "RESEND_API_KEY, EMAIL_FROM", note: "sb_secret_aaaa" },
    });
    for (const value of Object.values(rec.calls[0]!.properties)) {
      if (typeof value === "string") expect(value).not.toMatch(LEAK);
    }
    expect(rec.calls[0]!.properties.missing_config).toBe("RESEND_API_KEY, EMAIL_FROM");
  });
});

describe("captureRequestError", () => {
  it("strips the query string from the path", async () => {
    const rec = recordingCapture();
    await captureRequestError(
      rec.capture,
      new Error("boom"),
      { path: "/?checkout=success&session_id=cs_test_x", method: "GET" },
      {
        routerKind: "App Router",
        routePath: "/",
        routeType: "render",
        renderSource: "server-rendering",
      },
    );
    expect(rec.calls[0]!.properties).toEqual({
      app: "web",
      path: "/",
      method: "GET",
      route_path: "/",
      route_type: "render",
      router_kind: "App Router",
      render_source: "server-rendering",
      digest: null,
    });
    expect(rec.calls[0]!.distinctId).toBeUndefined();
    expect(rec.flushes()).toBe(1);
  });
});

describe("scrub", () => {
  it("truncates", () => {
    expect(scrub("a".repeat(900))).toHaveLength(500);
  });
});
