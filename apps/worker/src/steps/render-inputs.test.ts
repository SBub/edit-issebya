import { cacheKey } from "@edit-issebya/storage";
import { describe, expect, it, vi } from "vitest";
import { ensureRenderInputs } from "./render-inputs.ts";

const PREFIX = "dev/";
const INPUTS = { footage: "f1", transcript: "f1", cutout: "c1", headTrack: "h1" };
const FOOTAGE = cacheKey(PREFIX, "retime", "f1", "source.mp4");
const CUTOUT = cacheKey(PREFIX, "remove_background", "c1", "subject.webm");

// A storage that only answers head, from a set of stored keys.
function storing(keys: string[]) {
  const stored = new Set(keys);
  return {
    stored,
    storage: {
      head: vi.fn(async (key: string) => (stored.has(key) ? { bytes: 1, etag: "e" } : null)),
    },
  };
}

function ensure(
  storage: ReturnType<typeof storing>["storage"],
  rebuild: () => Promise<{ fingerprints: Record<string, string> }>,
) {
  return ensureRenderInputs({
    storage,
    keyPrefix: PREFIX,
    inputs: INPUTS,
    rebuild,
    signal: new AbortController().signal,
  });
}

describe("ensureRenderInputs", () => {
  it("rebuilds nothing when both inputs are stored", async () => {
    const { storage } = storing([FOOTAGE, CUTOUT]);
    const rebuild = vi.fn();
    expect(await ensure(storage, rebuild)).toEqual({ footage: FOOTAGE, cutout: CUTOUT });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds once when one input is missing, then finds it", async () => {
    const { storage, stored } = storing([FOOTAGE]);
    const rebuild = vi.fn(async () => {
      stored.add(CUTOUT);
      return { fingerprints: { retime: "f1", remove_background: "c1" } };
    });
    expect(await ensure(storage, rebuild)).toEqual({ footage: FOOTAGE, cutout: CUTOUT });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("fails when the rebuilt fingerprints are not the version's", async () => {
    const { storage } = storing([CUTOUT]);
    const rebuild = vi.fn(async () => ({
      fingerprints: { retime: "f2", remove_background: "c1" },
    }));
    await expect(ensure(storage, rebuild)).rejects.toThrow(
      "render: the inputs of this version cannot be rebuilt (a step changed since it was made)",
    );
  });

  it("fails when an input is still missing after the rebuild", async () => {
    const { storage } = storing([FOOTAGE]);
    const rebuild = vi.fn(async () => ({
      fingerprints: { retime: "f1", remove_background: "c1" },
    }));
    await expect(ensure(storage, rebuild)).rejects.toThrow(`render: input missing: ${CUTOUT}`);
  });
});
