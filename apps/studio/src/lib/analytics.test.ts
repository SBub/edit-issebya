import { describe, expect, it, vi } from "vitest";
import { startStudioAnalytics, studioPosthogOptions } from "./analytics";

function client() {
  return { init: vi.fn(), register: vi.fn() };
}

const ENV = { projectToken: "phc_test", host: "https://posthog.example" };

describe("startStudioAnalytics", () => {
  it.each([
    ["without the token", { ...ENV, projectToken: "" }, { webdriver: false }],
    ["without the host", { ...ENV, host: undefined }, { webdriver: false }],
    ["under webdriver", ENV, { webdriver: true }],
    ["without a browser", ENV, undefined],
  ])("does not initialise %s", (_label, env, browser) => {
    const c = client();
    expect(startStudioAnalytics(env, browser, c)).toBe(false);
    expect(c.init).not.toHaveBeenCalled();
    expect(c.register).not.toHaveBeenCalled();
  });

  it("initialises and registers app: studio otherwise", () => {
    const c = client();
    expect(startStudioAnalytics(ENV, { webdriver: false }, c)).toBe(true);
    expect(c.init).toHaveBeenCalledWith("phc_test", "https://posthog.example");
    expect(c.register).toHaveBeenCalledWith({ app: "studio" });
  });
});

describe("studioPosthogOptions", () => {
  it("keeps the identified user in memory, never cookieless", () => {
    const options = studioPosthogOptions("https://posthog.example", false);
    expect(options).toMatchObject({ api_host: "https://posthog.example", persistence: "memory" });
    expect(options).not.toHaveProperty("cookieless_mode");
  });
});
