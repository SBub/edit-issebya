import { describe, expect, it } from "vitest";
import { answerJson, buildTrace, formatTrace, hookOf, wordsBetween } from "./decision-trace.ts";

const words = ["Creating", "content", "is", "like", "exposure", "therapy"].map((text, index) => ({
  id: `w${index}`,
  text,
}));

describe("decision trace", () => {
  it("joins each proposal with what the engine did to it", () => {
    const trace = buildTrace(
      {
        accents: [
          { from: "w0", to: "w1", title: true },
          { from: "w4", to: "w5", title: false },
        ],
        big_words: [{ word: "w4" }],
        photos: [{ photo_id: "abcdef123456", from: "w2", to: "w3", reason: "mood" }],
        hook: { text: "Be seen" },
      },
      [
        { item: "accent-1", action: "moved", rule: "no-room", reason: "" },
        { item: "big-word-1", action: "dropped", rule: "big-word-visible", reason: "" },
        { item: "photo-1", action: "dropped", rule: "no-room", reason: "" },
        { item: "cw0", action: "low-contrast", rule: "contrast-stay", reason: "" },
      ],
      words,
    );
    expect(trace.rows.map((row) => [row.item, row.outcome])).toEqual([
      ["title", "kept"],
      ["accent-1", "changed"],
      ["big-word-1", "dropped"],
      ["photo-1", "dropped"],
      ["hook", "kept"],
    ]);
    expect(trace.rows[0]!.proposed).toBe('hook "Creating content"');
    expect(trace.rows[2]!.proposed).toBe('bigword "exposure"');
    expect(trace.rows[3]!.proposed).toBe('image abcdef12 (mood) on "is like"');
    expect(trace.otherNotes).toEqual({ "low-contrast (contrast-stay)": 1 });
    const text = formatTrace("v2", trace);
    expect(text).toContain("proposed 5: kept 2, changed 1, dropped 2");
    expect(text).toContain("other engine notes: 1x low-contrast (contrast-stay)");
  });

  it("names each proposal in the owner's words", () => {
    const trace = buildTrace(
      {
        accents: [
          { from: "w0", to: "w1", title: true },
          { from: "w2", to: "w3", wish: "top" },
        ],
        transitions: [
          { kind: "numbered", from: "w0", to: "w0" },
          { kind: "dim", from: "w1", to: "w2" },
          { kind: "panel", from: "w3", to: "w4", wish: "bottom" },
        ],
      },
      [],
      words,
    );
    expect(trace.rows.map((row) => [row.item, row.proposed])).toEqual([
      ["title", 'hook "Creating content"'],
      ["accent-1", 'accent "is like", wish top'],
      ["transition-1", 'list "Creating"'],
      ["transition-2", 'accent "content is" (dim)'],
      ["transition-3", 'accent "like exposure" (panel), wish bottom'],
    ]);
  });

  it("shortens long phrases and names unknown words by id", () => {
    expect(wordsBetween(words, "w0", "w5", 12)).toBe("Creating co…");
    expect(wordsBetween(words, "w0", "x9")).toBe("w0..x9");
  });

  it("reads a plain or fenced JSON answer", () => {
    expect(answerJson('{"a":1}')).toEqual({ a: 1 });
    expect(answerJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(answerJson("not json")).toBeNull();
    expect(answerJson(null)).toBeNull();
  });
});

describe("script view", () => {
  const said = (text: string) =>
    text.split(" ").map((word, index) => ({ id: `s${index}`, text: word }));
  const script = said(
    "The more experiments you run in your life, the closer you are to your dream life. Relationship, taste, purpose. A dream stays a dream.",
  );

  it("splits a long sentence at its middle comma", async () => {
    const { scriptLines } = await import("./decision-trace.ts");
    expect(scriptLines(script).map((line) => line.map((word) => word.text).join(" "))).toEqual([
      "The more experiments you run in your life,",
      "the closer you are to your dream life.",
      "Relationship, taste, purpose.",
      "A dream stays a dream.",
    ]);
  });

  it("lists each line's picks beside it", async () => {
    const { formatScript } = await import("./decision-trace.ts");
    const text = formatScript(
      "v2",
      {
        accents: [
          { from: "s1", to: "s2", title: true },
          { from: "s9", to: "s15" },
        ],
        big_words: [{ word: "s14" }],
        photos: [{ photo_id: "p1", from: "s19", to: "s22" }],
        transitions: [
          { kind: "numbered", from: "s16", to: "s16" },
          { kind: "numbered", from: "s17", to: "s17" },
          { kind: "dim", from: "s19", to: "s23" },
          { kind: "panel", from: "s20", to: "s20" },
        ],
        hook: { text: "Run more experiments" },
      },
      script,
      new Map([["p1", "bedroom"]]),
    );
    expect(text.split("\n")).toEqual([
      "v2",
      'HOOK  "Run more experiments"',
      "",
      'The more experiments you run in your life,  │ HOOK "more experiments"',
      'the closer you are to your dream life.      │ ACCENT "closer you are to your dream life" · BIGWORD "dream"',
      'Relationship, taste, purpose.               │ LIST "Relationship" "taste"',
      'A dream stays a dream.                      │ VISUAL photo bedroom · ACCENT whole line (dim) · ACCENT "dream" (panel)',
    ]);
  });
});

describe("decision trace of a VISUAL", () => {
  it("prints the description in the table, on its words, with the engine id visual-N", () => {
    const trace = buildTrace(
      {
        visuals: [{ from: "w2", to: "w3", description: "a messy desk at night" }],
      },
      [{ item: "visual-1", action: "shrunk", rule: "visual-size", reason: "" }],
      words,
    );
    expect(trace.rows).toEqual([
      expect.objectContaining({
        ref: "visuals[0]",
        item: "visual-1",
        proposed: 'visual "a messy desk at night" on "is like"',
        outcome: "changed",
        engine: "shrunk (visual-size)",
      }),
    ]);
  });

  it("prints VISUAL with its description on the words it sits on, in the script view", async () => {
    const { formatScript } = await import("./decision-trace.ts");
    const text = formatScript(
      "v3",
      { visuals: [{ from: "s9", to: "s15", description: "a messy desk at night" }] },
      [
        { id: "s9", text: "closer" },
        { id: "s10", text: "you" },
        { id: "s11", text: "are" },
        { id: "s12", text: "to" },
        { id: "s13", text: "your" },
        { id: "s14", text: "dream" },
        { id: "s15", text: "life." },
      ],
    );
    // A visual over the whole line shows its description alone.
    expect(text).toContain('VISUAL "a messy desk at night"');
    expect(text).not.toContain(' on "');
    // Over part of a line, the words it sits on follow it.
    const part = formatScript(
      "v3",
      { visuals: [{ from: "s10", to: "s14", description: "a calm lake" }] },
      [
        { id: "s9", text: "closer" },
        { id: "s10", text: "you" },
        { id: "s11", text: "are" },
        { id: "s12", text: "to" },
        { id: "s13", text: "your" },
        { id: "s14", text: "dream" },
        { id: "s15", text: "life." },
      ],
    );
    expect(part).toContain('VISUAL "a calm lake" on "you are to your dream"');
  });
});

describe("hookOf", () => {
  const hookCall = (text: string | null) => ({
    role: "hook",
    answerText: text === null ? null : JSON.stringify({ text }),
  });
  const decideCall = (answer: object) => ({ role: "decide", answerText: JSON.stringify(answer) });

  it("shows the hook of the hook call, not the decide answer's", () => {
    const calls = [hookCall("Be seen"), decideCall({ accents: [], hook: { text: "Old" } })];
    expect(hookOf(calls, { accents: [] })).toEqual({ text: "Be seen" });
  });

  it("reads the last readable hook call (a refused one is an earlier call)", () => {
    const calls = [hookCall(null), hookCall("Run more experiments")];
    expect(hookOf(calls, {})).toEqual({ text: "Run more experiments" });
  });

  it("falls back to the decide answer's hook for an older record", () => {
    const calls = [decideCall({ accents: [] })];
    expect(hookOf(calls, { accents: [], hook: { text: "Creating content" } })).toEqual({
      text: "Creating content",
    });
    expect(hookOf([], { accents: [] })).toBeNull();
  });
});
