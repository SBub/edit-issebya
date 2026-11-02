import { afterEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  __loaded: false,
}));
vi.mock("posthog-js", () => ({ default: posthog }));

// The landing page's opt-out is set on this device: the studio ignores it.
const store = new Map<string, string>([["edit_notrack", "1"]]);
const win = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
} as unknown as Window;
vi.stubGlobal("window", win);

const { capture, identify } = await import("./track");

afterEach(() => {
  delete win.__capturedEvents;
  posthog.capture.mockClear();
  posthog.identify.mockClear();
  posthog.__loaded = false;
});

describe("capture", () => {
  it("records the event with app: studio under automation, despite edit_notrack", () => {
    vi.stubGlobal("navigator", { webdriver: true });
    win.__capturedEvents = [];
    capture("studio_footage_uploaded", { reel_id: "r" });
    expect(win.__capturedEvents).toEqual([
      { event: "studio_footage_uploaded", properties: { app: "studio", reel_id: "r" } },
    ]);
    expect(posthog.capture).toHaveBeenCalledWith("studio_footage_uploaded", { reel_id: "r" });
  });

  it("records nothing without navigator.webdriver, and still calls PostHog", () => {
    vi.stubGlobal("navigator", { webdriver: false });
    win.__capturedEvents = [];
    capture("studio_footage_uploaded", { reel_id: "r" });
    expect(win.__capturedEvents).toEqual([]);
    expect(posthog.capture).toHaveBeenCalledOnce();
  });
});

describe("identify", () => {
  it("is a no-op before PostHog has loaded", () => {
    identify("user-1");
    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it("identifies with the user id once loaded", () => {
    posthog.__loaded = true;
    identify("user-1");
    expect(posthog.identify).toHaveBeenCalledWith("user-1");
  });
});
