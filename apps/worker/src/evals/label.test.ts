import { describe, expect, it } from "vitest";
import { transcriptOf } from "../../test-support/eval-fixtures.ts";
import { judgePicks, labelPick, overlap, sentPick } from "./label.ts";
import type { ComponentPick, OwnerMark, Span } from "./owner-marks.ts";

const span = (from: number, to: number): Span => ({ from, to });
const accent = (from: number, to: number): ComponentPick => ({
  component: "accent",
  span: span(from, to),
});
const bigword = (at: number): ComponentPick => ({ component: "bigword", span: span(at, at) });
const list = (items: Span[], level?: string): OwnerMark => ({
  component: "list",
  span: span(items[0]!.from, items.at(-1)!.to),
  items,
  ...(level ? { level } : {}),
});

describe("overlap", () => {
  it("counts the words two spans share", () => {
    expect(overlap(span(2, 5), span(4, 9))).toBe(2);
    expect(overlap(span(2, 5), span(6, 9))).toBe(0);
  });
});

describe("labelPick, a single mark", () => {
  const marks: OwnerMark[] = [accent(4, 7), bigword(12)];

  it("is good when it holds at least half of the owner's mark of the same component", () => {
    expect(labelPick(accent(6, 9), marks, [])).toEqual({ label: "good", why: "match" });
    expect(labelPick(accent(0, 30), marks, [])).toEqual({ label: "good", why: "match" });
  });

  it("is bad when it holds under half of the owner's mark", () => {
    expect(labelPick(accent(7, 9), marks, [])).toEqual({ label: "bad", why: "partial" });
  });

  it("is bad as the wrong component when the owner marked the words as another one", () => {
    expect(labelPick(bigword(5), marks, [])).toEqual({ label: "bad", why: "wrong-component" });
    expect(labelPick(accent(11, 13), marks, [])).toEqual({
      label: "bad",
      why: "wrong-component",
    });
  });

  it("is bad as an extra when the owner marked nothing there", () => {
    expect(labelPick(accent(20, 21), marks, [])).toEqual({ label: "bad", why: "extra" });
  });

  it("is bad as a setup line inside a span the owner marked as nothing", () => {
    expect(labelPick(accent(21, 22), marks, [span(20, 25)])).toEqual({
      label: "bad",
      why: "setup",
    });
    // Not inside: it only crosses the span's edge.
    expect(labelPick(accent(24, 27), marks, [span(20, 25)])).toEqual({
      label: "bad",
      why: "extra",
    });
  });

  it("stays good over words the owner also marked as another component", () => {
    expect(labelPick(accent(4, 7), [...marks, bigword(5)], [])).toEqual({
      label: "good",
      why: "match",
    });
  });
});

describe("labelPick, lists", () => {
  const owner = list([span(0, 2), span(3, 8), span(9, 12)], "phrases");

  it("is good when its items name at least half of the owner's items", () => {
    const named = list([span(1, 1), span(4, 5), span(8, 8), span(10, 11)]);
    expect(labelPick(named, [owner], [])).toEqual({ label: "good", why: "match" });
    expect(labelPick(list([span(0, 2), span(9, 9)]), [owner], [])).toEqual({
      label: "good",
      why: "match",
    });
  });

  it("is bad when it names under half of the owner's items", () => {
    expect(labelPick(list([span(1, 1), span(30, 31), span(40, 41)]), [owner], [])).toEqual({
      label: "bad",
      why: "partial",
    });
  });

  it("is bad when most of its own items are not the owner's", () => {
    const stray = list([span(0, 2), span(3, 8), span(30, 31), span(40, 41), span(50, 51)]);
    expect(labelPick(stray, [owner], [])).toEqual({ label: "bad", why: "partial" });
  });

  it("is an extra far from every mark, and the wrong component over another one's words", () => {
    const marks = [owner, accent(30, 33)];
    expect(labelPick(list([span(40, 41), span(43, 44)]), marks, [])).toEqual({
      label: "bad",
      why: "extra",
    });
    expect(labelPick(list([span(31, 32), span(43, 44)]), marks, [])).toEqual({
      label: "bad",
      why: "wrong-component",
    });
  });

  it("matches a sections list by naming at least half of its sections", () => {
    const sections = list([span(0, 19), span(20, 39), span(40, 59)], "sections");
    expect(labelPick(list([span(3, 4), span(25, 26)]), [sections], [])).toEqual({
      label: "good",
      why: "match",
    });
    expect(labelPick(list([span(3, 4), span(6, 7)]), [sections], [])).toEqual({
      label: "bad",
      why: "partial",
    });
  });

  it("makes a pick over a phrase list's item the wrong component, but never one inside a section", () => {
    expect(labelPick(accent(4, 5), [owner], [])).toEqual({ label: "bad", why: "wrong-component" });
    const sections = list([span(0, 19), span(20, 39)], "sections");
    expect(labelPick(accent(4, 5), [sections], [])).toEqual({ label: "bad", why: "extra" });
  });
});

describe("judgePicks", () => {
  const marks: OwnerMark[] = [accent(4, 7), bigword(12), list([span(20, 21), span(23, 24)])];
  const curator: ComponentPick[] = [
    accent(4, 7),
    accent(4, 7),
    accent(15, 16),
    bigword(5),
    list([span(20, 20), span(24, 24)]),
  ];
  const labelOf = (pick: ComponentPick) => labelPick(pick, marks, []);
  const OWNER = { label: "good", why: "owner" } as const;

  it("labels one curator run's picks by the owner's marks, and merges identical picks", () => {
    const picks = judgePicks("curator", curator, labelOf, "seed");
    expect(picks.map((pick) => pick.id).sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(picks.every((pick) => pick.source === "curator")).toBe(true);
    const by = (component: string, from: number) =>
      picks.find((pick) => pick.component === component && pick.span.from === from);
    expect(by("accent", 4)).toMatchObject({ label: "good", why: "match" });
    expect(by("accent", 15)).toMatchObject({ label: "bad", why: "extra" });
    expect(by("bigword", 5)).toMatchObject({ label: "bad", why: "wrong-component" });
    expect(by("list", 20)).toMatchObject({ label: "good", why: "match" });
  });

  it("judges the owner's marks alone, every one good by the owner", () => {
    const picks = judgePicks("owner", marks, () => OWNER, "seed");
    expect(picks.map((pick) => `${pick.component}:${pick.span.from}`).sort()).toEqual([
      "accent:4",
      "bigword:12",
      "list:20",
    ]);
    expect(picks.every((pick) => pick.source === "owner" && pick.why === "owner")).toBe(true);
  });

  it("holds the picks of its one source only: a curator copy of an owner mark is that run's own pick", () => {
    const run = judgePicks("curator", [accent(4, 7)], labelOf, "seed");
    expect(run).toMatchObject([{ id: "p1", source: "curator", label: "good", why: "match" }]);
    const owner = judgePicks("owner", marks, () => OWNER, "seed");
    expect(owner.some((pick) => pick.source === "curator")).toBe(false);
  });

  it("shuffles the same way for the same seed, whatever order the picks came in", () => {
    const order = (seed: string, picks: ComponentPick[]) =>
      judgePicks("curator", picks, labelOf, seed).map(
        (pick) => `${pick.component}:${pick.span.from}`,
      );
    expect(order("seed", curator)).toEqual(order("seed", [...curator].reverse()));
    expect(order("seed", curator)).not.toEqual(order("another seed", curator));
  });
});

describe("sentPick", () => {
  const words = transcriptOf("we work to live and we live to work").words;

  it("shows a pick as its words and seconds, a list with its items, and never its label", () => {
    const [first] = judgePicks(
      "owner",
      [accent(1, 3)],
      () => ({ label: "good", why: "owner" }),
      "seed",
    );
    expect(sentPick(first!, words)).toEqual({
      pick: "p1",
      component: "accent",
      words: "work to live",
      start: 1,
      end: 3.5,
    });
    const [listed] = judgePicks(
      "owner",
      [list([span(1, 1), span(7, 8)])],
      () => ({ label: "good", why: "owner" }),
      "s",
    );
    expect(sentPick(listed!, words)).toEqual({
      pick: "p1",
      component: "list",
      words: "work to live and we live to work",
      start: 1,
      end: 8.5,
      items: [
        { words: "work", start: 1, end: 1.5 },
        { words: "to work", start: 7, end: 8.5 },
      ],
    });
  });
});
