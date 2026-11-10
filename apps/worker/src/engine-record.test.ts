import type { EngineNote } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { engineRecordLine } from "./engine-record.ts";

const note: EngineNote = {
  item: "accent-1",
  component: "ACCENT",
  variant: "accent/above-head",
  start: 3.2,
  end: 4.1,
  rule: "zone",
  outcome: "moved",
  blockers: [{ kind: "face" }],
  reason: 'the accent "lock-in" moves to the upper third from 3.20 s to 4.10 s',
};

describe("engineRecordLine", () => {
  it("logs every note as item outcome (rule): reason, in order", () => {
    const line = engineRecordLine("reel-1", 3, [
      note,
      { ...note, item: "hook", outcome: "shrunk", rule: "size", reason: "the hook is smaller" },
    ]);
    expect(line).toBe(
      'engine record, reel reel-1, version 3: accent-1 moved (zone): the accent "lock-in" moves to the upper third from 3.20 s to 4.10 s; hook shrunk (size): the hook is smaller',
    );
  });

  it("says nothing moved for an empty record", () => {
    expect(engineRecordLine("reel-1", 1, [])).toBe(
      "engine record, reel reel-1, version 1: nothing moved",
    );
  });
});
