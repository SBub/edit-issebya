import { afterEach, describe, expect, it, vi } from "vitest";

const posthogCapture = vi.fn();
vi.mock("posthog-js", () => ({ default: { capture: posthogCapture } }));

const store = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const { capture } = await import("./track");

afterEach(() => {
  store.clear();
  posthogCapture.mockClear();
});

describe("capture", () => {
  it("sends the event when the device has not opted out", () => {
    capture("cta_clicked");
    expect(posthogCapture).toHaveBeenCalledWith("cta_clicked", undefined);
  });

  it("sends nothing after ?notrack", () => {
    store.set("edit_notrack", "1");
    capture("reel_played", { reel_id: "x" });
    expect(posthogCapture).not.toHaveBeenCalled();
  });
});

describe("the test hook", () => {
  const win = window as Window;

  afterEach(() => {
    delete win.__capturedEvents;
    vi.unstubAllGlobals();
    vi.stubGlobal("window", win);
  });

  it("records events in memory under automation when a spec set the array", () => {
    vi.stubGlobal("navigator", { webdriver: true });
    win.__capturedEvents = [];
    capture("cta_clicked");
    capture("reel_played", { reel_id: "x", variant: 1 });
    expect(win.__capturedEvents).toEqual([
      { event: "cta_clicked" },
      { event: "reel_played", properties: { reel_id: "x", variant: 1 } },
    ]);
    expect(posthogCapture).toHaveBeenCalledTimes(2);
  });

  it("records nothing without navigator.webdriver", () => {
    vi.stubGlobal("navigator", { webdriver: false });
    win.__capturedEvents = [];
    capture("cta_clicked");
    expect(win.__capturedEvents).toEqual([]);
  });

  it("records nothing after ?notrack", () => {
    vi.stubGlobal("navigator", { webdriver: true });
    win.__capturedEvents = [];
    store.set("edit_notrack", "1");
    capture("cta_clicked");
    expect(win.__capturedEvents).toEqual([]);
  });
});
