import { describe, expect, it } from "vitest";
import type { EngineNote } from "@edit-issebya/edit";
import {
  answerJson,
  buildTrace,
  formatScript,
  formatTrace,
  hookOf,
  scriptLines,
  traceHeading,
  wordsBetween,
} from "./decision-trace.ts";

// A note in the record's shape; the fields the trace does not read are fixed.
const note = (item: string, outcome: EngineNote["outcome"], rule: string): EngineNote => ({
  item,
  component: "ACCENT",
  variant: "accent/above-head",
  start: 0,
  end: 1,
  rule,
  outcome,
  blockers: [],
  reason: "",
});

const words = ["Creating", "content", "is", "like", "exposure", "therapy"].map((text, index) => ({
  id: `w${index}`,
  text,
}));

describe("decision trace", () => {
  it("traces a two-word big word as both words, and a one-word big word as its word", () => {
    const trace = buildTrace(
      {
        big_words: [
          { from: "w4", to: "w5" },
          { from: "w0", to: "w0" },
        ],
      },
      [],
      words,
    );
    expect(trace.rows.map((row) => row.proposed)).toEqual([
      'bigword "exposure therapy"',
      'bigword "Creating"',
    ]);
  });

  it("joins each proposal with what the engine did to it", () => {
    const trace = buildTrace(
      {
        accents: [
          { from: "w0", to: "w1" },
          { from: "w4", to: "w5" },
        ],
        big_words: [{ from: "w4", to: "w4" }],
        visuals: [{ from: "w2", to: "w3", description: "a lamp" }],
        hook: { text: "Be seen" },
      },
      [
        note("accent-1", "moved", "no-room"),
        note("big-word-1", "shrunk", "size"),
        note("visual-1", "covers-face", "face"),
        note("cw0", "placed", "contrast"),
      ],
      words,
    );
    expect(trace.rows.map((row) => [row.item, row.outcome])).toEqual([
      ["accent-1", "changed"],
      ["accent-2", "kept"],
      ["big-word-1", "changed"],
      ["visual-1", "changed"],
      ["hook", "kept"],
    ]);
    expect(trace.rows[0]!.proposed).toBe('accent "Creating content"');
    expect(trace.rows[2]!.proposed).toBe('bigword "exposure"');
    expect(trace.rows[3]!.proposed).toBe('visual "a lamp" on "is like"');
    expect(trace.otherNotes).toEqual({ "placed (contrast)": 1 });
    const text = formatTrace("v2", trace);
    expect(text).toContain("proposed 5: kept 2, changed 3");
    expect(text).toContain("other engine notes: 1x placed (contrast)");
  });

  it("calls a proposal kept when the engine only placed it, changed on any other note", () => {
    const trace = buildTrace(
      {
        accents: [
          { from: "w0", to: "w1" },
          { from: "w4", to: "w5" },
        ],
      },
      [note("accent-1", "placed", "zone"), note("accent-2", "shrunk", "size")],
      words,
    );
    expect(trace.rows.map((row) => [row.item, row.outcome, row.engine])).toEqual([
      ["accent-1", "kept", "placed (zone)"],
      ["accent-2", "changed", "shrunk (size)"],
    ]);
  });

  it("names each proposal in the owner's words, each LIST item by its list and its place", () => {
    const trace = buildTrace(
      {
        accents: [
          { from: "w0", to: "w1" },
          { from: "w2", to: "w3" },
        ],
        lists: [
          { items: [{ from: "w0", to: "w0" }] },
          {
            items: [
              { from: "w3", to: "w3" },
              { from: "w4", to: "w4" },
            ],
          },
        ],
      },
      [],
      words,
    );
    expect(trace.rows.map((row) => [row.item, row.proposed])).toEqual([
      ["accent-1", 'accent "Creating content"'],
      ["accent-2", 'accent "is like"'],
      ["transition-1", 'list 1.1 "Creating"'],
      ["transition-2", 'list 2.1 "like"'],
      ["transition-3", 'list 2.2 "exposure"'],
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
          { from: "s1", to: "s2" },
          { from: "s9", to: "s15" },
        ],
        big_words: [{ from: "s14", to: "s14" }],
        visuals: [{ from: "s19", to: "s22", description: "a bedroom" }],
        lists: [
          {
            items: [
              { from: "s16", to: "s16" },
              { from: "s17", to: "s17" },
            ],
          },
        ],
        hook: { text: "Run more experiments" },
      },
      script,
    );
    expect(text.split("\n")).toEqual([
      "v2",
      'HOOK  "Run more experiments"',
      "",
      `${"The more experiments you run in your life,".padEnd(60)}  │ ACCENT "more experiments"`,
      `${"the closer you are to your dream life.".padEnd(60)}  │ ACCENT "closer you are to your dream life"`,
      `${"".padEnd(60)}  │ BIGWORD "dream"`,
      `${"Relationship, taste, purpose.".padEnd(60)}  │ LIST 1 "Relationship" "taste"`,
      `${"A dream stays a dream.".padEnd(60)}  │ VISUAL "a bedroom" on "A dream stays a"`,
    ]);
  });
});

// Unpunctuated speech: 80 six-letter words, 0.3 s each, with the gap after each
// word given by `pauseAfter`. Eight words to a group is 55 characters.
const GROUPS = ["garden", "window", "planet", "silver", "rocket", "forest", "candle", "bridge"];
function spoken(count: number, pauseAfter: (index: number) => number | undefined) {
  let at = 0;
  return Array.from({ length: count }, (_, index) => {
    const word = { id: `u${index}`, text: GROUPS[index % 8]!, start: at, end: at + 0.3 };
    at = word.end + (pauseAfter(index) ?? 0.02);
    return word;
  });
}
const ids = (lines: { id: string }[][]) => lines.map((line) => line.map((word) => word.id));
const group = (first: number, count: number) =>
  Array.from({ length: count }, (_, index) => `u${first + index}`);

describe("script view of unpunctuated speech", () => {
  it("breaks at the biggest pauses into lines of at most 60 characters", () => {
    // A pause of 0.8 s after every sixth word, and a shorter 0.4 s pause after the third.
    // A line over 60 characters splits at the 0.8 s pauses, not at word 8 as a fixed width would.
    const words = spoken(80, (index) =>
      index % 6 === 5 ? 0.8 : index % 6 === 2 ? 0.4 : undefined,
    );
    const lines = scriptLines(words);
    expect(ids(lines)).toEqual([
      ...Array.from({ length: 12 }, (_, line) => group(line * 6, 6)),
      group(72, 8),
    ]);
    for (const line of lines) {
      expect(line.map((word) => word.text).join(" ").length).toBeLessThanOrEqual(60);
    }
  });

  it("prefers a pause to a word boundary when a stretch over 60 characters has one", () => {
    // Ten words (69 characters) with one 0.5 s pause after the fifth.
    const words = spoken(10, (index) => (index === 4 ? 0.5 : undefined));
    expect(ids(scriptLines(words))).toEqual([group(0, 5), group(5, 5)]);
  });

  it("breaks at word boundaries within 60 characters when there are no timings", () => {
    const words = spoken(80, () => undefined).map(({ id, text }) => ({ id, text }));
    expect(ids(scriptLines(words))).toEqual(
      Array.from({ length: 10 }, (_, line) => group(line * 8, 8)),
    );
  });

  it("prints one row per pick when a line has several, the script on the first row", () => {
    const words = ["Quiet", "room", "again", "and", "more."].map((text, index) => ({
      id: `q${index}`,
      text,
    }));
    const text = formatScript(
      "v4",
      {
        accents: [{ from: "q0", to: "q1" }],
        big_words: [{ from: "q2", to: "q2" }],
        visuals: [{ from: "q4", to: "q4", description: "a lamp" }],
      },
      words,
    );
    expect(text.split("\n")).toEqual([
      "v4",
      "HOOK  none",
      "",
      `${"Quiet room again and more.".padEnd(60)}  │ ACCENT "Quiet room"`,
      `${"".padEnd(60)}  │ BIGWORD "again"`,
      `${"".padEnd(60)}  │ VISUAL "a lamp" on "more"`,
    ]);
  });
});

describe("trace heading", () => {
  it("names both prompt versions, and the decide attempts when there were more than one", () => {
    const prompts = { hook_prompt_version: "reel-hook@v1", prompt_version: "reel-components@v1" };
    expect(traceHeading("== version 4 ==", prompts, 1)).toBe(
      "== version 4 == (prompts reel-hook@v1, reel-components@v1)",
    );
    expect(traceHeading("== version 4 ==", prompts, 2)).toBe(
      "== version 4 == (prompts reel-hook@v1, reel-components@v1, 2 decide attempts)",
    );
  });

  it("names the edit intensity the components prompt was filled with, when recorded", () => {
    const prompts = {
      hook_prompt_version: "reel-hook@v1",
      prompt_version: "reel-components@v1",
      intensity: "intense",
    };
    expect(traceHeading("== version 4 ==", prompts, 1)).toBe(
      "== version 4 == (prompts reel-hook@v1, reel-components@v1, intensity intense)",
    );
    expect(traceHeading("== version 4 ==", prompts, 2)).toBe(
      "== version 4 == (prompts reel-hook@v1, reel-components@v1, intensity intense, 2 decide attempts)",
    );
  });

  it("names the target picks after the intensity, when recorded", () => {
    const prompts = {
      hook_prompt_version: "reel-hook@v1",
      prompt_version: "reel-components@v1",
      intensity: "intense",
      target_picks: 24,
    };
    expect(traceHeading("== version 4 ==", prompts, 1)).toBe(
      "== version 4 == (prompts reel-hook@v1, reel-components@v1, intensity intense, target 24)",
    );
    expect(traceHeading("== version 4 ==", prompts, 2)).toBe(
      "== version 4 == (prompts reel-hook@v1, reel-components@v1, intensity intense, target 24, 2 decide attempts)",
    );
  });
});

describe("decision trace of a QUESTION", () => {
  it("prints the question in the table as question-N on its words, kept when the engine kept it", () => {
    const trace = buildTrace({ questions: [{ from: "w1", to: "w2" }] }, [], words);
    expect(trace.rows).toEqual([
      expect.objectContaining({
        ref: "questions[0]",
        item: "question-1",
        proposed: 'question "content is"',
        outcome: "kept",
      }),
    ]);
  });

  it("prints QUESTION with its words in the script view, and an older answer has none", () => {
    const text = formatScript("v4", { questions: [{ from: "w1", to: "w2" }] }, words);
    expect(text).toContain('QUESTION "content is"');
    expect(formatScript("v4", {}, words)).not.toContain("QUESTION");
  });
});

describe("decision trace of a VISUAL", () => {
  it("prints the description in the table, on its words, with the engine id visual-N", () => {
    const trace = buildTrace(
      {
        visuals: [{ from: "w2", to: "w3", description: "a messy desk at night" }],
      },
      [note("visual-1", "shrunk", "size")],
      words,
    );
    expect(trace.rows).toEqual([
      expect.objectContaining({
        ref: "visuals[0]",
        item: "visual-1",
        proposed: 'visual "a messy desk at night" on "is like"',
        outcome: "changed",
        engine: "shrunk (size)",
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
