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
