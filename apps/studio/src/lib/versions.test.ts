import { describe, expect, it } from "vitest";
import { type VersionListRow, versionLabel } from "./versions";

function row(number: number, fields: Partial<VersionListRow> = {}): VersionListRow {
  return {
    id: `v${number}`,
    number,
    created_at: "2026-11-01T10:00:00Z",
    request: null,
    change_summary: null,
    restored_from_id: null,
    parent_id: null,
    ...fields,
  };
}

describe("versionLabel", () => {
  const rows = [
    row(4, { restored_from_id: "v1" }),
    row(3, { request: "no accent on 'work'" }),
    row(2),
    row(1),
  ];

  it("quotes the request of a change", () => {
    expect(versionLabel(rows[1]!, rows)).toBe(`"no accent on 'work'"`);
  });

  it("names the version a restore copied", () => {
    expect(versionLabel(rows[0]!, rows)).toBe("restored from v1");
  });

  it("calls a version made without a request automatic", () => {
    expect(versionLabel(rows[2]!, rows)).toBe("automatic");
  });

  it("still labels a restore of a version not in the list", () => {
    expect(versionLabel(row(5, { restored_from_id: "gone" }), rows)).toBe(
      "restored from an earlier version",
    );
  });
});
