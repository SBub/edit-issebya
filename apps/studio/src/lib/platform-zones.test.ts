import { ISSEBYA_PRESET, PLATFORM_SAFE } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { platformZones } from "./platform-zones";

const zones = platformZones(ISSEBYA_PRESET.frame, PLATFORM_SAFE);
const byId = Object.fromEntries(zones.map((zone) => [zone.id, zone]));

describe("platformZones", () => {
  it("shades the four zones at the guard's edges", () => {
    expect(zones.map((zone) => zone.id)).toEqual(["top", "bottom", "left", "right"]);
    expect(byId.top).toMatchObject({ left: 0, top: 0, width: 100 });
    expect(byId.top!.height).toBeCloseTo((252 / 1920) * 100);
    expect(byId.bottom!.top).toBeCloseTo((1164 / 1920) * 100);
    expect(byId.bottom!.top + byId.bottom!.height).toBeCloseTo(100);
    expect(byId.left!.width).toBeCloseTo((120 / 1080) * 100);
    expect(byId.right!.left).toBeCloseTo((840 / 1080) * 100);
    expect(byId.right!.left + byId.right!.width).toBeCloseTo(100);
  });

  it("never overlaps two zones", () => {
    for (const a of zones) {
      for (const b of zones) {
        if (a === b) continue;
        const apart =
          a.left + a.width <= b.left + 1e-9 ||
          b.left + b.width <= a.left + 1e-9 ||
          a.top + a.height <= b.top + 1e-9 ||
          b.top + b.height <= a.top + 1e-9;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
    }
  });
});
