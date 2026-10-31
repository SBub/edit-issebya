import { describe, expect, it } from "vitest";
import { parsePsTable, treeRssBytes } from "./process-tree.ts";

const PS = `    1     0   12000
  100     1    5000
  101   100  100000
  102   100  100000
  103   102   50000
  200     1  999999
`;

describe("parsePsTable", () => {
  it("reads pid, ppid and rss per row and skips junk", () => {
    expect(parsePsTable(`${PS}\nnot a row\n`)).toHaveLength(6);
    expect(parsePsTable(PS)[2]).toEqual({ pid: 101, ppid: 100, rssKb: 100_000 });
  });
});

describe("treeRssBytes", () => {
  const rows = parsePsTable(PS);

  it("sums the root and nested grandchildren, not siblings outside the tree", () => {
    expect(treeRssBytes(rows, 100)).toBe((5000 + 100_000 + 100_000 + 50_000) * 1024);
  });

  it("is zero for a pid that is gone", () => {
    expect(treeRssBytes(rows, 4242)).toBe(0);
  });

  it("survives a cycle", () => {
    const cyclic = [
      { pid: 1, ppid: 2, rssKb: 1 },
      { pid: 2, ppid: 1, rssKb: 1 },
    ];
    expect(treeRssBytes(cyclic, 1)).toBe(2 * 1024);
  });
});
