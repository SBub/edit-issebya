import { describe, expect, it, vi } from "vitest";
import { internalTagAction, posthogInitOptions, startAnalytics } from "./analytics";

describe("internalTagAction", () => {
  it("tags on internal=1", () => {
    expect(internalTagAction("?internal=1")).toBe("tag");
  });

  it("untags on internal=0", () => {
    expect(internalTagAction("?internal=0")).toBe("untag");
  });

  it("is null for any other value or no parameter", () => {
    expect(internalTagAction("?internal=yes")).toBeNull();
    expect(internalTagAction("?internal=")).toBeNull();
    expect(internalTagAction("?foo=1")).toBeNull();
    expect(internalTagAction("")).toBeNull();
  });

  it("finds the parameter beside others", () => {
    expect(internalTagAction("?a=b&internal=1")).toBe("tag");
  });

  it("takes the first value when repeated", () => {
    expect(internalTagAction("?internal=1&internal=0")).toBe("tag");
  });
});

const PROD = {
  vercelEnv: "production",
  projectToken: "phc_test",
  host: "https://eu.i.posthog.com",
};

function fakeAnalyticsClient() {
  return { init: vi.fn(), register: vi.fn(), unregister: vi.fn() };
}

describe("startAnalytics", () => {
  it("never initialises an automated browser, even with ?internal=1", () => {
    const client = fakeAnalyticsClient();
    const started = startAnalytics(PROD, { webdriver: true, search: "?internal=1" }, client);
    expect(started).toBe(false);
    expect(client.init).not.toHaveBeenCalled();
    expect(client.register).not.toHaveBeenCalled();
    expect(client.unregister).not.toHaveBeenCalled();
  });

  it("initialises a real browser on production without tagging", () => {
    const client = fakeAnalyticsClient();
    expect(startAnalytics(PROD, { webdriver: false, search: "" }, client)).toBe(true);
    expect(client.init).toHaveBeenCalledTimes(1);
    expect(client.init).toHaveBeenCalledWith("phc_test", PROD.host);
    expect(client.register).not.toHaveBeenCalled();
    expect(client.unregister).not.toHaveBeenCalled();
  });

  it("treats an undefined webdriver like false", () => {
    const client = fakeAnalyticsClient();
    startAnalytics(PROD, { webdriver: undefined, search: "" }, client);
    expect(client.init).toHaveBeenCalledTimes(1);
  });

  it("registers internal after init on ?internal=1", () => {
    const client = fakeAnalyticsClient();
    startAnalytics(PROD, { webdriver: false, search: "?internal=1" }, client);
    expect(client.register).toHaveBeenCalledTimes(1);
    expect(client.register).toHaveBeenCalledWith({ internal: true });
    expect(client.init.mock.invocationCallOrder[0]).toBeLessThan(
      client.register.mock.invocationCallOrder[0] ?? 0,
    );
    expect(client.unregister).not.toHaveBeenCalled();
  });

  it("unregisters internal on ?internal=0", () => {
    const client = fakeAnalyticsClient();
    startAnalytics(PROD, { webdriver: false, search: "?internal=0" }, client);
    expect(client.unregister).toHaveBeenCalledTimes(1);
    expect(client.unregister).toHaveBeenCalledWith("internal");
    expect(client.register).not.toHaveBeenCalled();
  });

  it.each([
    ["a preview deploy", { ...PROD, vercelEnv: "preview" }],
    ["no Vercel env", { ...PROD, vercelEnv: undefined }],
    ["a missing token", { ...PROD, projectToken: undefined }],
    ["a missing host", { ...PROD, host: undefined }],
  ])("does nothing with %s", (_label, env) => {
    const client = fakeAnalyticsClient();
    const started = startAnalytics(env, { webdriver: false, search: "?internal=1" }, client);
    expect(started).toBe(false);
    expect(client.init).not.toHaveBeenCalled();
    expect(client.register).not.toHaveBeenCalled();
  });

  it("does nothing without a browser", () => {
    const client = fakeAnalyticsClient();
    expect(() => startAnalytics(PROD, undefined, client)).not.toThrow();
    expect(client.init).not.toHaveBeenCalled();
  });
});

describe("posthogInitOptions", () => {
  it("runs PostHog cookieless, so nothing is stored on the device", () => {
    const options = posthogInitOptions("https://eu.i.posthog.com", false);
    expect(options).toEqual({
      api_host: "https://eu.i.posthog.com",
      defaults: "2026-01-30",
      capture_exceptions: true,
      cookieless_mode: "always",
      debug: false,
    });
    // No persistence override that would bring cookies or storage back.
    expect(options).not.toHaveProperty("persistence");
    expect(options).not.toHaveProperty("disable_persistence");
  });
});
