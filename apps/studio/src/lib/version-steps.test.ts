import { describe, expect, it } from "vitest";
import { nextVersionId, previousVersionId, shownVersionId } from "./version-steps";

// Out of order, with a gap in the numbering (3 is missing).
const VERSIONS = [
  { id: "v4", number: 4 },
  { id: "v1", number: 1 },
  { id: "v5", number: 5 },
  { id: "v2", number: 2 },
];

describe("previousVersionId", () => {
  it("gives the version saved just before, across a gap", () => {
    expect(previousVersionId(VERSIONS, "v5")).toBe("v4");
    expect(previousVersionId(VERSIONS, "v4")).toBe("v2");
    expect(previousVersionId(VERSIONS, "v2")).toBe("v1");
  });

  it("is null at the first version, for an unknown id or with no versions", () => {
    expect(previousVersionId(VERSIONS, "v1")).toBeNull();
    expect(previousVersionId(VERSIONS, "v9")).toBeNull();
    expect(previousVersionId(VERSIONS, null)).toBeNull();
    expect(previousVersionId([], "v1")).toBeNull();
  });
});

describe("nextVersionId", () => {
  it("gives the version saved just after, across a gap", () => {
    expect(nextVersionId(VERSIONS, "v1")).toBe("v2");
    expect(nextVersionId(VERSIONS, "v2")).toBe("v4");
    expect(nextVersionId(VERSIONS, "v4")).toBe("v5");
  });

  it("is null at the newest version or for an unknown id", () => {
    expect(nextVersionId(VERSIONS, "v5")).toBeNull();
    expect(nextVersionId(VERSIONS, "v9")).toBeNull();
    expect(nextVersionId(VERSIONS, null)).toBeNull();
  });
});

describe("shownVersionId", () => {
  it("shows the current version without a selection", () => {
    expect(shownVersionId(null, "v5")).toBe("v5");
    expect(shownVersionId(null, null)).toBeNull();
  });

  it("shows the selection while the current version is the one it was made for", () => {
    expect(shownVersionId({ id: "v2", forCurrent: "v5" }, "v5")).toBe("v2");
  });

  it("drops a selection made for an older current version", () => {
    expect(shownVersionId({ id: "v2", forCurrent: "v5" }, "v6")).toBe("v6");
    expect(shownVersionId({ id: "v2", forCurrent: null }, "v1")).toBe("v1");
  });
});
