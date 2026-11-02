import { afterEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  captureException: vi.fn(),
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

const { capture, captureException, identify } = await import("./track");

afterEach(() => {
  delete win.__capturedEvents;
  posthog.capture.mockClear();
  posthog.identify.mockClear();
  posthog.captureException.mockClear();
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

describe("captureException", () => {
  const properties = { status: 500, error_code: "failed", resumed: false };

  it("records one $exception with app: studio under automation, and never calls PostHog", () => {
    vi.stubGlobal("navigator", { webdriver: true });
    win.__capturedEvents = [];
    captureException("studio: upload failed", properties);
    expect(win.__capturedEvents).toEqual([
      {
        event: "$exception",
        properties: { app: "studio", $exception_message: "studio: upload failed", ...properties },
      },
    ]);
    expect(posthog.captureException).not.toHaveBeenCalled();
  });

  it("records nothing without navigator.webdriver or without the array", () => {
    vi.stubGlobal("navigator", { webdriver: false });
    win.__capturedEvents = [];
    captureException("studio: upload failed", properties);
    expect(win.__capturedEvents).toEqual([]);
    vi.stubGlobal("navigator", { webdriver: true });
    delete win.__capturedEvents;
    expect(() => captureException("studio: upload failed", properties)).not.toThrow();
  });

  it("sends to PostHog once loaded", () => {
    vi.stubGlobal("navigator", { webdriver: false });
    posthog.__loaded = true;
    captureException("studio: upload failed", properties);
    expect(posthog.captureException).toHaveBeenCalledOnce();
    const [error, sent] = posthog.captureException.mock.calls[0]!;
    expect((error as Error).message).toBe("studio: upload failed");
    expect(sent).toEqual(properties);
  });
});
