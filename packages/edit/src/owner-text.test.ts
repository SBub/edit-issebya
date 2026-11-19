import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { captionBlocks, captionText } from "./caption-blocks.ts";
import type { PlacedComponent } from "./components.ts";
import { applyOwnerMoves, ownerMoveProblems } from "./owner-edit.ts";
import {
  type OwnerText,
  applyOwnerTexts,
  cleanOwnerText,
  effectiveTexts,
  ownerTextLimit,
  ownerTextOf,
  ownerTextProblem,
  ownerTextRecords,
  parseOwnerTexts,
  spreadWords,
} from "./owner-text.ts";
import { ISSEBYA_PRESET, wordsText } from "./preset.ts";
import { hookReveal, wordReveal } from "./reveal.ts";
import { soundCues } from "./sounds.ts";
import { type Edit, parseEdit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import { type Fixture, FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// Two placed versions: one with the hook, two accents and a big word, one with
// two numbered LIST items as well.
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const lists = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;
const preset = ISSEBYA_PRESET;

async function contextOf(fixture: Fixture) {
  return {
    transcript: fixture.transcript,
    headTrack: fixture.headTrack,
    preset,
    measurer: await nodeMeasurer(),
  };
}

async function builtOf(fixture: Fixture, edit: Edit = fixture.edit) {
  const context = await contextOf(fixture);
  return build(edit, context.transcript, context.headTrack, preset, context.measurer);
}

function byId(components: readonly PlacedComponent[], id: string): PlacedComponent {
  const found = components.find((component) => component.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

async function applied(fixture: Fixture, texts: OwnerText[], edit: Edit = fixture.edit) {
  const result = applyOwnerTexts(edit, texts, await contextOf(fixture));
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return result.edit;
}

const overlayOf = (edit: Edit, id: string) => edit.tracks.overlays.find((item) => item.id === id)!;
const centre = (box: { x: number; width: number }) => box.x + box.width / 2;

// The first caption group of the fixture with at least three captions, and its block.
function groupOf(fixture: Fixture, atLeast = 3) {
  for (const block of captionBlocks(fixture.edit, fixture.transcript)) {
    const group = block.groups.find((entry) => entry.captions.length >= atLeast);
    if (group) return { block, group };
  }
  throw new Error("no caption group that long");
}

describe("the owner's text as it is stored", () => {
  it("is one line with single spaces and no control character", () => {
    expect(cleanOwnerText("  sense   of\n purpose\t ")).toBe("sense of purpose");
    expect(cleanOwnerText("a\u0000b\u007f")).toBe("ab");
    expect(cleanOwnerText(" \n ")).toBe("");
  });

  it("may be three times the text it replaces, never fewer than 40 characters nor more than the format holds", () => {
    expect(ownerTextLimit("work")).toBe(40);
    expect(ownerTextLimit("a".repeat(20))).toBe(60);
    expect(ownerTextLimit("a".repeat(150))).toBe(200);
    expect(ownerTextLimit("a".repeat(150), 300)).toBe(300);
  });

  it("parses a save's text edits and refuses anything else", () => {
    expect(parseOwnerTexts(undefined)).toEqual([]);
    expect(parseOwnerTexts([])).toEqual([]);
    expect(
      parseOwnerTexts([
        { id: "accent-1", text: "a sense of purpose", more: 1 },
        { id: "transition-1", part: "key", text: "mental health" },
        { id: "block_cw1", part: "cw4", text: "we tested this" },
      ]),
    ).toEqual([
      { id: "accent-1", text: "a sense of purpose" },
      { id: "transition-1", part: "key", text: "mental health" },
      { id: "block_cw1", part: "cw4", text: "we tested this" },
    ]);
    for (const bad of [
      "texts",
      [null],
      [{ id: "", text: "a" }],
      [{ id: "accent-1" }],
      [{ id: "accent-1", text: 3 }],
      [{ id: "accent-1", text: " padded " }],
      [{ id: "accent-1", text: "two  spaces" }],
      [{ id: "accent-1", part: 2, text: "a" }],
      [{ id: "accent-1", text: "a".repeat(301) }],
      [
        { id: "accent-1", text: "a" },
        { id: "accent-1", text: "b" },
      ],
      Array.from({ length: 201 }, (_, index) => ({ id: `accent-${index}`, text: "a" })),
    ]) {
      expect(parseOwnerTexts(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
    // The same element's two parts are two edits.
    expect(
      parseOwnerTexts([
        { id: "transition-1", part: "lead", text: "a" },
        { id: "transition-1", part: "key", text: "b" },
      ]),
    ).toHaveLength(2);
  });

  it("spreads a text's words over its units in order, as the reveal spreads them over spoken words", () => {
    expect(spreadWords("a b c", 3)).toEqual([["a"], ["b"], ["c"]]);
    // Two words written for one unit come in together on it.
    expect(spreadWords("a b c d", 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(spreadWords("a b c", 2)).toEqual([["a", "b"], ["c"]]);
    // One word written for two units is on the first; a unit can have none.
    expect(spreadWords("a b", 4)).toEqual([["a"], [], ["b"], []]);
    expect(spreadWords("a", 3)).toEqual([["a"], [], []]);
    // The same units the reveal picks for the same counts.
    const spoken = [{ start: 1 }, { start: 2 }, { start: 3 }, { start: 4 }];
    const reveal = wordReveal("a b", spoken, { start: 0, end: 9 });
    expect(reveal.map((word) => word.at)).toEqual([0, 3]);
  });
});

describe("a text edited by the owner", () => {
  it("changes an accent's text only: its words, its time, its size and every other element stay", async () => {
    const before = overlayOf(hook.edit, "accent-1");
    const was = byId((await builtOf(hook)).components, "accent-1");
    const edit = await applied(hook, [{ id: "accent-1", text: "badly disrupted" }]);
    const after = overlayOf(edit, "accent-1");
    expect(after.text).toBe("badly disrupted");
    expect(after.words).toEqual(before.words);
    expect(after.start).toEqual(before.start);
    expect(after.end).toEqual(before.end);
    expect(after.size).toBe(before.size);
    // Nothing else: the captions of the same spoken words keep their text, as
    // does every other overlay, big word and sound.
    expect(edit.tracks.captions).toEqual(hook.edit.tracks.captions);
    expect(edit.tracks.overlays.filter((item) => item.id !== "accent-1")).toEqual(
      hook.edit.tracks.overlays.filter((item) => item.id !== "accent-1"),
    );
    expect(edit.tracks.behind).toEqual(hook.edit.tracks.behind);
    expect(edit.tracks.sounds).toEqual(hook.edit.tracks.sounds);
    // The box keeps its top, its centre line and its size; it is no wider.
    const built = await builtOf(hook, edit);
    const now = byId(built.components, "accent-1");
    expect(now.text).toBe("badly disrupted");
    expect(now.y).toBe(was.y);
    expect(now.size).toBe(was.size);
    expect(now.start).toBe(was.start);
    expect(now.end).toBe(was.end);
    expect(centre(now)).toBeCloseTo(centre(was), 1);
    expect(parseEdit(JSON.parse(JSON.stringify(edit)), preset, hook.transcript).ok).toBe(true);
  });

  it("leaves another element that shows the same spoken word as it was", async () => {
    // A second accent on the very word accent-1 shows.
    const word = overlayOf(hook.edit, "accent-1").words!;
    const shared: Edit = {
      ...hook.edit,
      tracks: {
        ...hook.edit.tracks,
        overlays: hook.edit.tracks.overlays.map((item) =>
          item.id === "accent-2" ? { ...item, words: word } : item,
        ),
      },
    };
    const before = (await builtOf(hook, shared)).components;
    expect(byId(before, "accent-2").text).toBe(byId(before, "accent-1").text);
    const edit = await applied(hook, [{ id: "accent-1", text: "interrupted" }], shared);
    const after = (await builtOf(hook, edit)).components;
    expect(byId(after, "accent-1").text).toBe("interrupted");
    // The other accent, the hook and the captions keep their text.
    expect(overlayOf(edit, "accent-2")).toEqual(overlayOf(shared, "accent-2"));
    expect(byId(after, "accent-2")).toEqual(byId(before, "accent-2"));
    expect(byId(after, "hook")).toEqual(byId(before, "hook"));
    expect(edit.tracks.captions).toEqual(shared.tracks.captions);
  });

  it("wraps a longer text again inside the box's width: the box grows downward, never wider", async () => {
    const was = byId((await builtOf(hook)).components, "accent-1");
    const edit = await applied(hook, [{ id: "accent-1", text: "disrupted and badly disrupted" }]);
    const now = byId((await builtOf(hook, edit)).components, "accent-1");
    expect(now.width).toBeLessThanOrEqual(was.width + 1e-6);
    expect(now.height).toBeGreaterThan(was.height);
    expect(now.height % was.size!).toBe(0);
    expect(now.y).toBe(was.y);
    expect(overlayOf(edit, "accent-1").breaks!.length).toBe(now.height / was.size! - 1);
  });

  it("keeps the timing tied to the spoken words: the new words come in on the same spoken words, in order", async () => {
    const item = overlayOf(hook.edit, "accent-1");
    const edit = await applied(hook, [{ id: "accent-1", text: "badly disrupted now" }]);
    const html = (await builtOf(hook, edit)).html;
    const span = resolveTimeline(edit, hook.transcript).get("accent-1")!;
    expect(span).toEqual(resolveTimeline(hook.edit, hook.transcript).get("accent-1"));
    // Three words written for the one spoken word: three word elements, all in
    // on that word, as the reveal spreads a text over its spoken words.
    const spoken = item.words!.map((id) => hook.transcript.words.find((word) => word.id === id)!);
    const reveal = wordReveal("badly disrupted now", spoken, span);
    expect(new Set(reveal.map((word) => word.at)).size).toBe(1);
    for (const [index, word] of reveal.entries()) {
      expect(html).toContain(`<span id="accent-1_w${index + 1}" class="q">${word.text}</span>`);
    }
    expect(html).not.toContain('id="accent-1_w4"');
    const tweens = [...html.matchAll(/accent-1_w\d[^\n]*, ([\d.]+)\);/g)].map((match) =>
      Number(match[1]),
    );
    expect(tweens).toEqual(reveal.map((word) => Math.round(word.at * 1000) / 1000));
    // The out-fade is where it was.
    const out = (page: string) => page.match(/tl\.to\("#accent-1"[^\n]*/)?.[0];
    expect(out(html)).toBe(out((await builtOf(hook)).html));
    expect(out(html)).toBeDefined();
  });

  it("changes the hook's text and nothing about its window", async () => {
    const before = overlayOf(hook.edit, "hook");
    const was = byId((await builtOf(hook)).components, "hook");
    const edit = await applied(hook, [{ id: "hook", text: "Gen Z will not work like you" }]);
    const after = overlayOf(edit, "hook");
    expect(after).toMatchObject({ kind: "hook", text: "Gen Z will not work like you" });
    expect(after.words).toBeUndefined();
    expect([after.start, after.end, after.size]).toEqual([before.start, before.end, before.size]);
    const built = await builtOf(hook, edit);
    const now = byId(built.components, "hook");
    expect([now.start, now.end, now.y]).toEqual([was.start, was.end, was.y]);
    expect(centre(now)).toBeCloseTo(centre(was), 1);
  });

  it("types the hook's new text letter by letter, with its caret and its key sounds", async () => {
    const text = "Gen Z will not work like you";
    const edit = await applied(hook, [{ id: "hook", text }]);
    const { html } = await builtOf(hook, edit);
    const span = resolveTimeline(edit, hook.transcript).get("hook")!;
    const reveal = hookReveal(text, span);
    expect(reveal).toHaveLength(text.replaceAll(" ", "").length);
    // The new words, each an element holding its letters, on the wrapped lines.
    const line = html.split("\n").find((entry) => entry.includes('<span id="hook"'))!;
    const shown = line
      .trim()
      .replace(/<br \/>/g, " ")
      .replace(/<[^>]+>/g, "");
    expect(shown).toBe(text);
    expect([...line.matchAll(/<span id="hook_w\d+" class="w">/g)]).toHaveLength(
      text.split(" ").length,
    );
    // Every letter cuts in at its own moment, the last at 60% of the window;
    // each but the last holds the caret, cut when the next letter appears.
    for (const [index, letter] of reveal.entries()) {
      expect(html).toContain(
        `tl.fromTo("#hook_c${index + 1}", { opacity: 0 }, { opacity: 1, duration: 0.001 }, ${letter.at});`,
      );
      if (index === 0) continue;
      expect(line).toContain(`<i id="hook_b${index}" class="cr"></i>`);
      expect(html).toContain(
        `tl.fromTo("#hook_b${index}", { opacity: 1 }, { opacity: 0, duration: 0.001 }, ${letter.at});`,
      );
    }
    expect(html).not.toContain(`id="hook_c${reveal.length + 1}"`);
    expect(html).not.toContain(`id="hook_b${reveal.length}"`);
    // A key sound in step with the new letters: one clip a cue, each starting
    // on the millisecond a letter of the new text appears.
    const keys = soundCues(
      edit,
      resolveTimeline(edit, hook.transcript),
      preset,
      hook.transcript.voice,
    ).filter((cue) => cue.id.startsWith("hook_k"));
    expect(keys.length).toBeGreaterThan(0);
    expect([...html.matchAll(/<audio id="hook_k\d+"/g)]).toHaveLength(keys.length);
    const moments = new Set(reveal.map((letter) => letter.at));
    for (const cue of keys) expect(moments.has(cue.at)).toBe(true);
    expect(keys[0]!.at).toBe(span.start);
  });

  it("keeps a question's mark and its left edge", async () => {
    const question: Edit = {
      ...hook.edit,
      tracks: {
        ...hook.edit.tracks,
        overlays: hook.edit.tracks.overlays.map((item) =>
          item.id === "accent-1" ? { ...item, id: "question-1" } : item,
        ),
        captions: hook.edit.tracks.captions.map((item) =>
          item.hidden_by === "accent-1" ? { ...item, hidden_by: "question-1" } : item,
        ),
      },
    };
    const context = await contextOf(hook);
    const was = byId((await builtOf(hook, question)).components, "question-1");
    expect(ownerTextOf(question, { id: "question-1" }, context)!.text).toBe(was.text);
    expect(was.text.endsWith("?")).toBe(true);
    const edit = await applied(hook, [{ id: "question-1", text: "why work" }], question);
    const now = byId((await builtOf(hook, edit)).components, "question-1");
    expect(now.text).toBe("why work?");
    expect(now.x).toBe(was.x);
    expect(now.y).toBe(was.y);
    // A mark the owner typed is never doubled.
    const marked = await applied(hook, [{ id: "question-1", text: "why work?" }], question);
    expect(byId((await builtOf(hook, marked)).components, "question-1").text).toBe("why work?");
  });

  it("changes a big word to any text within the general limit: wrapped inside its width, built and measured, its top and centre kept", async () => {
    const context = await contextOf(hook);
    const was = byId((await builtOf(hook)).components, "big-word-1");
    const short = await applied(hook, [{ id: "big-word-1", text: "purpose" }]);
    const one = byId((await builtOf(hook, short)).components, "big-word-1");
    expect(one.text).toBe("purpose");
    expect([one.y, one.size, one.height, one.start, one.end]).toEqual([
      was.y,
      was.size,
      was.size,
      was.start,
      was.end,
    ]);
    // More than two words, with a character the AI answer may not use: no
    // special rule for the owner, only the general length limit.
    const text = "a long & winding distribution of work";
    expect(ownerTextProblem(hook.edit, { id: "big-word-1", text }, context)).toBeNull();
    const edit = await applied(hook, [{ id: "big-word-1", text }]);
    const item = edit.tracks.behind!.find((entry) => entry.id === "big-word-1")!;
    const old = hook.edit.tracks.behind!.find((entry) => entry.id === "big-word-1")!;
    if (item.kind !== "word" || old.kind !== "word") throw new Error("not a big word");
    expect(item.text).toBe(text);
    expect(item.breaks!.length).toBeGreaterThan(0);
    expect([item.words, item.start, item.end, item.size, item.cutout]).toEqual([
      old.words,
      old.start,
      old.end,
      old.size,
      old.cutout,
    ]);
    const built = await builtOf(hook, edit);
    const now = byId(built.components, "big-word-1");
    // Wrapped inside the word's width: taller by whole lines, never wider than
    // it was unless one word is, its top and its centre line kept.
    expect(now.text).toBe(text);
    expect(now.y).toBe(was.y);
    expect(now.size).toBe(was.size);
    expect(now.height).toBe(was.size! * (item.breaks!.length + 1));
    const widestWord = Math.max(
      ...text.split(" ").map((word) => context.measurer.width("artistic", was.size!, word)),
      ...text.split(" ").map((word) => context.measurer.width("simple", was.size!, word)),
    );
    expect(now.width).toBeLessThanOrEqual(Math.max(was.width, widestWord) + 1e-6);
    // Drawn on its lines, escaped, centred.
    expect(built.html).toContain("&amp;");
    expect(built.html).not.toContain("long & winding");
    expect(built.html).toMatch(/id="big-word-1"[^>]*text-align: center[^>]*>[^<]+<br \/>/);
    expect(parseEdit(JSON.parse(JSON.stringify(edit)), preset, hook.transcript).ok).toBe(true);
    // Only the general limit binds it.
    expect(
      applyOwnerTexts(hook.edit, [{ id: "big-word-1", text: "x".repeat(41) }], context),
    ).toEqual({
      ok: false,
      reasons: ["big-word-1: This text can be at most 40 characters (it has 41)"],
    });
  });

  it("changes a LIST's key phrase or lead-in, the other level's lines and the number kept", async () => {
    const context = await contextOf(lists);
    const list = lists.edit.tracks.transitions[0]!;
    const was = byId((await builtOf(lists)).components, list.id);
    expect(was.parts!.map((part) => part.id)).toEqual(["lead", "key"]);
    expect(ownerTextOf(lists.edit, { id: list.id, part: "key" }, context)!.text).toBe(
      list.levels!.key.text,
    );
    const edit = await applied(lists, [{ id: list.id, part: "key", text: "fair pay now" }]);
    const after = edit.tracks.transitions[0]!;
    expect(after.levels!.key.text).toBe("fair pay now");
    expect(after.levels!.key.breaks!.length).toBeGreaterThanOrEqual(1);
    expect(after.levels!.key.size).toBe(list.levels!.key.size);
    expect(after.levels!.lead!.text).toBe(list.levels!.lead!.text);
    expect(after.levels!.lead!.breaks).toEqual(list.levels!.lead!.breaks);
    expect(after.levels!.number).toEqual(list.levels!.number);
    expect([after.words, after.key, after.start, after.end]).toEqual([
      list.words,
      list.key,
      list.start,
      list.end,
    ]);
    expect(edit.tracks.transitions.slice(1)).toEqual(lists.edit.tracks.transitions.slice(1));
    const now = byId((await builtOf(lists, edit)).components, list.id);
    expect(now.y).toBe(was.y);
    expect(Math.abs(centre(now) - centre(was))).toBeLessThanOrEqual(1);
    expect(now.parts!.find((part) => part.id === "key")!.text).toBe("fair pay now");
    // The number is not a text the owner edits.
    expect(ownerTextOf(lists.edit, { id: list.id, part: "number" }, context)).toBeNull();
    expect(
      applyOwnerTexts(lists.edit, [{ id: list.id, part: "number", text: "9" }], context),
    ).toEqual({
      ok: false,
      reasons: [
        `${list.id}: a list's text is its lead-in or its key phrase; its number is not edited`,
      ],
    });
  });
});

describe("a caption block's text edited by the owner", () => {
  it("fixes one word: only that caption's text changes, every caption keeps its word and its time", async () => {
    const context = await contextOf(hook);
    const { block, group } = groupOf(hook);
    const target = { id: block.id, part: group.id };
    const text = ownerTextOf(hook.edit, target, context)!.text;
    const words = text.split(" ");
    expect(words).toHaveLength(group.captions.length);
    const fixed = [words[0], "FIXED", ...words.slice(2)].join(" ");
    const edit = await applied(hook, [{ ...target, text: fixed }]);
    const second = group.captions[1]!;
    for (const item of edit.tracks.captions) {
      const old = hook.edit.tracks.captions.find((entry) => entry.id === item.id)!;
      if (item.id !== second) {
        // The other captions of the group and of the reel: byte for byte, or
        // (in the block, when its width changed) moved and nothing else.
        expect({ ...item, position: null }).toEqual({ ...old, position: null });
        continue;
      }
      expect(item.text).toBe("FIXED");
      expect({ ...item, text: undefined, position: null }).toEqual({
        ...old,
        text: undefined,
        position: null,
      });
    }
    expect(edit.tracks.captions).toHaveLength(hook.edit.tracks.captions.length);
    expect(edit.tracks.overlays).toEqual(hook.edit.tracks.overlays);
    expect(resolveTimeline(edit, hook.transcript)).toEqual(
      resolveTimeline(hook.edit, hook.transcript),
    );
    // The block keeps its top, its centre line and its size.
    const was = byId((await builtOf(hook)).components, block.id);
    const built = await builtOf(hook, edit);
    const now = byId(built.components, block.id);
    expect(now.y).toBe(was.y);
    expect(now.size).toBe(was.size);
    expect(centre(now)).toBeCloseTo(centre(was), 1);
    expect(now.parts!.find((part) => part.id === group.id)!.text).toBe(fixed);
    expect(built.html).toContain(`<span id="${second}_w1" class="q">FIXED</span>`);
    expect(parseEdit(JSON.parse(JSON.stringify(edit)), preset, hook.transcript).ok).toBe(true);
  });

  it("spreads more words over the same captions: a caption shows two words on its one spoken word", async () => {
    const { block, group } = groupOf(hook);
    const count = group.captions.length;
    const text = Array.from({ length: count * 2 }, (_, index) => `w${index}`).join(" ");
    const edit = await applied(hook, [{ id: block.id, part: group.id, text }]);
    const now = group.captions.map((id) => edit.tracks.captions.find((item) => item.id === id)!);
    expect(now.map((item) => item.text)).toEqual(
      Array.from({ length: count }, (_, index) => `w${index * 2} w${index * 2 + 1}`),
    );
    const old = group.captions.map((id) =>
      hook.edit.tracks.captions.find((item) => item.id === id)!,
    );
    expect(now.map((item) => [item.words, item.start, item.end])).toEqual(
      old.map((item) => [item.words, item.start, item.end]),
    );
  });

  it("spreads fewer words over the captions: a caption left with none joins the one before, no spoken word lost", async () => {
    const { block, group } = groupOf(hook);
    const old = group.captions.map((id) =>
      hook.edit.tracks.captions.find((item) => item.id === id)!,
    );
    const edit = await applied(hook, [{ id: block.id, part: group.id, text: "one" }]);
    const first = edit.tracks.captions.find((item) => item.id === group.id)!;
    expect(first.text).toBe("one");
    // It shows from the group's first spoken word to the group's end, as before.
    expect([first.start, first.end]).toEqual([old[0]!.start, old[0]!.end]);
    expect(first.words).toEqual(old.flatMap((item) => item.words));
    for (const id of group.captions.slice(1)) {
      expect(edit.tracks.captions.some((item) => item.id === id)).toBe(false);
    }
    // The track's order and every other caption stay.
    expect(edit.tracks.captions.map((item) => item.id)).toEqual(
      hook.edit.tracks.captions
        .map((item) => item.id)
        .filter((id) => id === group.id || !group.captions.includes(id)),
    );
    const blocks = captionBlocks(edit, hook.transcript);
    const again = blocks.find((entry) => entry.id === block.id)!;
    expect(again.groups.map((entry) => entry.id)).toEqual(block.groups.map((entry) => entry.id));
    expect(again.groups.find((entry) => entry.id === group.id)!.captions).toEqual([group.id]);
    expect([again.start, again.end]).toEqual([block.start, block.end]);
    const built = await builtOf(hook, edit);
    expect(byId(built.components, block.id).parts!.find((part) => part.id === group.id)!.text).toBe(
      "one",
    );
    expect(parseEdit(JSON.parse(JSON.stringify(edit)), preset, hook.transcript).ok).toBe(true);
    // A second edit of the same group in the same save is refused; edited again
    // from the version it is spread over the version's captions.
    const twice = await applied(hook, [
      { id: block.id, part: group.id, text: old.map((_, index) => `n${index}`).join(" ") },
    ]);
    expect(
      group.captions.map((id) => twice.tracks.captions.find((item) => item.id === id)!.text),
    ).toEqual(old.map((_, index) => `n${index}`));
  });

  it("wraps the edited group inside the block's width and leaves the other groups where they are", async () => {
    const { block, group } = groupOf(hook);
    const was = byId((await builtOf(hook)).components, block.id);
    const text = Array.from({ length: group.captions.length }, () => "considerably").join(" ");
    const edit = await applied(hook, [{ id: block.id, part: group.id, text }]);
    const built = await builtOf(hook, edit);
    const now = byId(built.components, block.id);
    expect(now.y).toBe(was.y);
    expect(now.size).toBe(was.size);
    expect(Math.abs(centre(now) - centre(was))).toBeLessThan(0.02);
    // No wider than it was unless a single caption is (a caption is never cut).
    const part = now.parts!.find((entry) => entry.id === group.id)!;
    const widest = Math.max(...part.items!.map((id) => byId(built.components, id).width));
    expect(now.width).toBeLessThanOrEqual(Math.max(was.width, widest) + 0.02);
    // The longer words take more lines: the group is deeper than it was.
    expect(part.height).toBeGreaterThan(was.parts!.find((entry) => entry.id === group.id)!.height);
    if (Math.abs(now.width - was.width) < 0.005) {
      for (const other of block.groups.filter((entry) => entry.id !== group.id)) {
        for (const id of other.captions) {
          expect(edit.tracks.captions.find((item) => item.id === id)).toEqual(
            hook.edit.tracks.captions.find((item) => item.id === id),
          );
        }
      }
    }
  });

  it("edits two groups of one sentence in one save", async () => {
    const context = await contextOf(hook);
    const block = captionBlocks(hook.edit, hook.transcript).find(
      (entry) => entry.groups.length >= 2 && entry.groups[0]!.captions.length >= 2,
    );
    if (!block) throw new Error("no block with two groups");
    const [first, second] = block.groups;
    const edit = await applied(hook, [
      { id: block.id, part: first!.id, text: "one" },
      {
        id: block.id,
        part: second!.id,
        text: `${ownerTextOf(hook.edit, { id: block.id, part: second!.id }, context)!.text} more`,
      },
    ]);
    const parts = byId((await builtOf(hook, edit)).components, block.id).parts!;
    expect(parts[0]!.text).toBe("one");
    expect(parts[1]!.text.endsWith(" more")).toBe(true);
  });
});

describe("the limits of a text edit", () => {
  it("refuses an empty text, one over three times the original (40 characters at least), an unknown element and one edited twice", async () => {
    const context = await contextOf(hook);
    const original = ownerTextOf(hook.edit, { id: "accent-1" }, context)!;
    expect(original.limit).toBe(Math.max(40, original.text.length * 3));
    expect(ownerTextProblem(hook.edit, { id: "accent-1", text: "" }, context)).toBe(
      "A text cannot be empty",
    );
    const long = "a".repeat(original.limit + 1);
    expect(ownerTextProblem(hook.edit, { id: "accent-1", text: long }, context)).toBe(
      `This text can be at most ${original.limit} characters (it has ${original.limit + 1})`,
    );
    expect(
      ownerTextProblem(hook.edit, { id: "accent-1", text: "a".repeat(original.limit) }, context),
    ).toBeNull();
    expect(ownerTextProblem(hook.edit, { id: "visual-1", text: "a card" }, context)).toBe(
      "This text cannot be edited",
    );
    expect(applyOwnerTexts(hook.edit, [{ id: "accent-1", text: "" }], context)).toEqual({
      ok: false,
      reasons: ["accent-1: A text cannot be empty"],
    });
    expect(applyOwnerTexts(hook.edit, [{ id: "accent-1", text: long }], context)).toMatchObject({
      ok: false,
    });
    const single = hook.edit.tracks.captions[0]!.id;
    expect(
      applyOwnerTexts(
        hook.edit,
        [
          { id: "visual-1", text: "a card" },
          { id: single, text: "a caption" },
          { id: "accent-9", text: "nothing" },
        ],
        context,
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "visual-1: not a text of this version",
        `${single}: not a text of this version`,
        "accent-9: not a text of this version",
      ],
    });
    expect(
      applyOwnerTexts(
        hook.edit,
        [
          { id: "accent-1", text: "one" },
          { id: "accent-1", text: "two" },
        ],
        context,
      ),
    ).toEqual({ ok: false, reasons: ["accent-1: its text is edited twice"] });
    // The limit is measured against the version's text, not an earlier draft's.
    const { block, group } = groupOf(hook);
    const part = { id: block.id, part: group.id };
    expect(ownerTextOf(hook.edit, part, context)!.limit).toBe(
      Math.max(40, ownerTextOf(hook.edit, part, context)!.text.length * 3),
    );
  });

  it("leaves a version with no text edit as it is, and leaves out an edit that changes nothing", async () => {
    const context = await contextOf(hook);
    const none = applyOwnerTexts(hook.edit, [], context);
    expect(none.ok && none.edit).toBe(hook.edit);
    const same = ownerTextOf(hook.edit, { id: "accent-1" }, context)!.text;
    expect(effectiveTexts([{ id: "accent-1", text: same }], hook.edit, context)).toEqual([]);
    const changed = [{ id: "accent-1", text: `${same} now` }];
    expect(effectiveTexts(changed, hook.edit, context)).toEqual(changed);
    // A version saved before text edits builds as before: no item gained a field.
    for (const item of hook.edit.tracks.captions) {
      expect(captionText(item, hook.transcript, preset)).toBe(
        item.text ?? wordsText(item.words, hook.transcript, preset),
      );
    }
  });

  it("stays inside the safe zone with the move the studio settles, and is named when it does not", async () => {
    const context = await contextOf(hook);
    const was = byId((await builtOf(hook)).components, "hook");
    const edit = await applied(hook, [
      { id: "hook", text: "Gen Z won't work like you did at all" },
    ]);
    const components = (await builtOf(hook, edit)).components;
    expect(ownerMoveProblems(components, ["hook"])).toEqual([]);
    // A text edit and a move of the same element: the text first, then the move.
    const moved = applyOwnerMoves(
      edit,
      [{ id: "hook", x: was.x, y: was.y + 100, size: was.size! }],
      {
        ...context,
      },
    );
    if (!moved.ok) throw new Error(moved.reasons.join("; "));
    const now = byId((await builtOf(hook, moved.edit)).components, "hook");
    expect(now).toMatchObject({
      x: was.x,
      y: was.y + 100,
      text: "Gen Z won't work like you did at all",
    });
  });
});

describe("the learning records of text edits", () => {
  it("records each edit: the element, its part, the text before and after and its spoken words", async () => {
    const context = await contextOf(hook);
    const { block, group } = groupOf(hook);
    const part = { id: block.id, part: group.id };
    const beforeText = ownerTextOf(hook.edit, part, context)!.text;
    const texts: OwnerText[] = [
      { id: "accent-1", text: "badly disrupted" },
      { id: "hook", text: "Gen Z will not work like you" },
      { ...part, text: `${beforeText} today` },
    ];
    const edit = await applied(hook, texts);
    const before = { edit: hook.edit, components: (await builtOf(hook)).components };
    const after = { edit, components: (await builtOf(hook, edit)).components };
    const records = ownerTextRecords({
      texts,
      before,
      after,
      transcript: hook.transcript,
      preset,
      engineRecord: [
        {
          item: "accent-1",
          component: "ACCENT",
          variant: "accent/above-head",
          start: 0,
          end: 1,
          rule: "zone",
          outcome: "placed",
          blockers: [],
          reason: "placed",
        },
      ],
    });
    const accent = overlayOf(hook.edit, "accent-1");
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      item: "accent-1",
      part: null,
      component: "ACCENT",
      variant: "accent/above-head",
      before: wordsText(accent.words!, hook.transcript, preset),
      after: "badly disrupted",
      word_ids: accent.words,
      start: byId(before.components, "accent-1").start,
      end: byId(before.components, "accent-1").end,
    });
    expect(records[0]!.words.split(" ")).toHaveLength(accent.words!.length);
    expect(records[0]!.context).toMatchObject({
      frame: { width: 1080, height: 1920 },
      font_pair: hook.edit.font_pair,
      size: byId(after.components, "accent-1").size,
    });
    expect(records[0]!.context.before_box!.y).toBe(records[0]!.context.after_box!.y);
    // The hook has no spoken words.
    expect(records[1]).toMatchObject({ item: "hook", component: "HOOK", words: "", word_ids: [] });
    expect(records[2]).toMatchObject({
      item: block.id,
      part: group.id,
      component: "CAPTION",
      before: beforeText,
      after: `${beforeText} today`,
    });
    expect(records[2]!.word_ids).toEqual(
      group.captions.flatMap(
        (id) => hook.edit.tracks.captions.find((item) => item.id === id)!.words,
      ),
    );
  });
});
