import { describe, expect, it, vi } from "vitest";
import {
  applyNotrackSwitch,
  isTrackingDisabled,
  NOTRACK_KEY,
  notrackAction,
  searchWithoutSwitches,
  type FlagStorage,
} from "./notrack";

function memoryStorage(): FlagStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const THROWING: FlagStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("notrackAction", () => {
  it("reads ?notrack and ?track, with or without a value", () => {
    expect(notrackAction("?notrack")).toBe("disable");
    expect(notrackAction("?notrack=1")).toBe("disable");
    expect(notrackAction("?track")).toBe("enable");
    expect(notrackAction("?notrack&track")).toBe("disable");
    expect(notrackAction("")).toBeNull();
    expect(notrackAction("?utm_source=ig")).toBeNull();
  });
});

describe("searchWithoutSwitches", () => {
  it("drops only the two switches", () => {
    expect(searchWithoutSwitches("?notrack")).toBe("");
    expect(searchWithoutSwitches("?track")).toBe("");
    expect(searchWithoutSwitches("?utm_source=ig&notrack")).toBe("?utm_source=ig");
  });
});

describe("applyNotrackSwitch and isTrackingDisabled", () => {
  it("sets the flag on ?notrack and clears it on ?track", () => {
    const storage = memoryStorage();
    expect(isTrackingDisabled(storage)).toBe(false);
    expect(applyNotrackSwitch(storage, "?notrack")).toBe("");
    expect(storage.data.get(NOTRACK_KEY)).toBe("1");
    expect(NOTRACK_KEY).toBe("edit_notrack");
    expect(isTrackingDisabled(storage)).toBe(true);
    expect(applyNotrackSwitch(storage, "?track&utm_source=ig")).toBe("?utm_source=ig");
    expect(isTrackingDisabled(storage)).toBe(false);
  });

  it("leaves storage alone without a switch", () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");
    expect(applyNotrackSwitch(storage, "?utm_source=ig")).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("never throws when storage is blocked or missing", () => {
    expect(applyNotrackSwitch(THROWING, "?notrack")).toBe("");
    expect(isTrackingDisabled(THROWING)).toBe(false);
    expect(applyNotrackSwitch(undefined, "?notrack")).toBe("");
    expect(isTrackingDisabled(undefined)).toBe(false);
  });
});
