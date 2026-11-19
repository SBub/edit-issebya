import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { editFromAnswer } from "./decide.ts";
import {
  OWNER_ADD_SECONDS,
  applyOwnerAdds,
  keepOwnerAdds,
  nextOwnerVisualId,
  ownerAddPlacement,
  ownerAddSpan,
  ownerAddWord,
  ownerPictures,
  parseOwnerAdds,
} from "./owner-add.ts";
import { ownerMoveProblems, settleOwnerMove } from "./owner-edit.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { type Edit, parseEdit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// A card the owner adds from their library (app_docs/owner-edits.md).
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const preset = ISSEBYA_PRESET;
const PHOTO = {
  id: "11111111-2222-4333-8444-555555555555",
  width: 1600,
  height: 900,
  description: "a bright kitchen with a laptop on the table",
  tags: ["kitchen"],
};
const photos = new Map([[PHOTO.id, PHOTO]]);
const word = (id: string) => hook.transcript.words.find((entry) => entry.id === id)!;

async function contextOf() {
  return {
    transcript: hook.transcript,
    headTrack: hook.headTrack,
    preset,
    measurer: await nodeMeasurer(),
    photos,
  };
}

// The fixture with its footage hidden from `start` to `end` seconds.
function hiddenFrom(start: number, end: number): Edit {
  const [clip, ...rest] = hook.edit.tracks.footage;
  return {
    ...hook.edit,
    tracks: {
      ...hook.edit.tracks,
      footage: [{ ...clip!, hidden: [{ start: { time: start }, end: { time: end } }] }, ...rest],
    },
  };
}

describe("a card the owner adds", () => {
  it("parses added cards, and refuses a malformed one", () => {
    const add = { id: "owner-visual-1", photo_id: PHOTO.id, word: "w10", x: 1, y: 2, width: 300 };
    expect(parseOwnerAdds(undefined)).toEqual([]);
    expect(parseOwnerAdds([{ ...add, extra: 1 }])).toEqual([add]);
    for (const bad of [
      null,
      {},
      [{ ...add, id: "visual-1" }],
      [{ ...add, id: "owner-visual-0" }],
      [{ ...add, photo_id: "x" }],
      [{ ...add, word: "" }],
      [{ ...add, width: -1 }],
      [{ ...add, x: Number.NaN }],
      [add, add],
      Array.from({ length: 21 }, (_, index) => ({ ...add, id: `owner-visual-${index + 1}` })),
    ]) {
      expect(parseOwnerAdds(bad)).toBeNull();
    }
  });

  it("starts on the word under the playhead, in a pause the one just spoken, and lasts a fixed time", () => {
    const at = word("w10");
    expect(ownerAddWord(hook.transcript, (at.start + at.end) / 2)?.id).toBe("w10");
    const gap = hook.transcript.words.findIndex(
      (entry, index) => hook.transcript.words[index + 1]!.start > entry.end + 0.05,
    );
    const before = hook.transcript.words[gap]!;
    // In the pause after a word, the card starts on that word, so it is on
    // screen at the paused moment.
    expect(ownerAddWord(hook.transcript, before.end + 0.01)?.id).toBe(before.id);
    // Before the first word, the first; after the last, the last.
    expect(ownerAddWord(hook.transcript, -1)?.id).toBe(hook.transcript.words[0]!.id);
    expect(ownerAddWord(hook.transcript, 1e6)?.id).toBe(hook.transcript.words.at(-1)!.id);
    expect(ownerAddSpan(hook.edit, hook.transcript, "w10")).toEqual({
      start: at.start,
      end: Math.round((at.start + OWNER_ADD_SECONDS) * 1000) / 1000,
    });
    expect(ownerAddSpan(hook.edit, hook.transcript, "nope")).toBeNull();
  });

  it("is cut short by the reel's end and the next hidden footage, and refused inside hidden footage", () => {
    const last = hook.transcript.words.at(-1)!;
    const end = ownerAddSpan(hook.edit, hook.transcript, last.id);
    if (end) expect(end.end).toBeLessThanOrEqual(hook.edit.duration);
    const at = word("w10");
    const cut = hiddenFrom(at.start + 0.8, at.start + 3);
    expect(ownerAddSpan(cut, hook.transcript, "w10")?.end).toBeCloseTo(at.start + 0.8, 3);
    expect(
      ownerAddSpan(hiddenFrom(at.start - 0.1, at.start + 2), hook.transcript, "w10"),
    ).toBeNull();
    // Less than the shown floor left before the hidden stretch: none.
    expect(
      ownerAddSpan(hiddenFrom(at.start + 0.2, at.start + 2), hook.transcript, "w10"),
    ).toBeNull();
  });

  it("names the next card one past the highest added", () => {
    expect(nextOwnerVisualId(hook.edit)).toBe("owner-visual-1");
    const edit = {
      ...hook.edit,
      tracks: {
        ...hook.edit.tracks,
        behind: [
          ...hook.edit.tracks.behind!,
          { ...hook.edit.tracks.behind![0]!, id: "owner-visual-4" },
        ],
      },
    };
    expect(nextOwnerVisualId(edit)).toBe("owner-visual-5");
  });

  it("adds a card at the end of the track showing the photo at its aspect, with a click when no other is near", async () => {
    const context = await contextOf();
    const applied = applyOwnerAdds(
      hook.edit,
      [{ id: "owner-visual-1", photo_id: PHOTO.id, word: "w10", x: 600, y: 300, width: 360 }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    const card = applied.edit.tracks.behind!.at(-1)!;
    expect(card).toMatchObject({
      id: "owner-visual-1",
      kind: "visual",
      start: { word: "w10" },
      description: PHOTO.description,
      photo: { id: PHOTO.id, width: 1600, height: 900 },
      box: { x: 600, y: 300, width: 360, height: 203 },
    });
    expect(applied.edit.inputs.photos).toEqual([PHOTO.id]);
    const span = resolveTimeline(applied.edit, hook.transcript).get("owner-visual-1")!;
    expect(span.start).toBe(word("w10").start);
    expect(span.end - span.start).toBeCloseTo(OWNER_ADD_SECONDS, 2);
    expect(applied.edit.tracks.sounds.map((sound) => sound.id)).toContain("click-owner-visual-1");
    // The edit still parses, and its page draws the card last.
    expect(parseEdit(applied.edit, preset, hook.transcript).ok).toBe(true);
  });

  it("gives no click to a card within the click's gap of another sound", async () => {
    const context = await contextOf();
    // On the engine card's own word: its click is at the same moment.
    const applied = applyOwnerAdds(
      hook.edit,
      [{ id: "owner-visual-1", photo_id: PHOTO.id, word: "w18", x: 600, y: 300, width: 360 }],
      context,
    );
    if (!applied.ok) throw new Error(applied.reasons.join("; "));
    expect(applied.edit.tracks.sounds.map((sound) => sound.id)).not.toContain(
      "click-owner-visual-1",
    );
    const { checks } = build(
      applied.edit,
      hook.transcript,
      hook.headTrack,
      preset,
      context.measurer,
    );
    expect(checks.filter((check) => check.rule === "sound-gap")).toEqual([]);
  });

  it("refuses a card twice, a photo not vouched for, a word with no room and a width under 100 px", async () => {
    const context = await contextOf();
    const add = {
      id: "owner-visual-1",
      photo_id: PHOTO.id,
      word: "w10",
      x: 600,
      y: 300,
      width: 360,
    };
    expect(applyOwnerAdds(hook.edit, [{ ...add, id: "visual-1" }], context).ok).toBe(false);
    expect(applyOwnerAdds(hook.edit, [add], { ...context, photos: new Map() })).toEqual({
      ok: false,
      reasons: [`owner-visual-1: photo ${PHOTO.id} is not a ready photo in your library`],
    });
    const at = word("w10");
    expect(applyOwnerAdds(hiddenFrom(at.start - 0.1, at.start + 2), [add], context).ok).toBe(false);
    expect(applyOwnerAdds(hook.edit, [{ ...add, width: 50 }], context).ok).toBe(false);
  });

  it("places a card in a corner with the engine's placement, off the card already there, and settles it", async () => {
    const context = await contextOf();
    // Over the engine's card (w18 to w24).
    const span = ownerAddSpan(hook.edit, hook.transcript, "w19")!;
    const at = ownerAddPlacement(hook.edit, PHOTO, span, context);
    expect(at.width).toBeGreaterThanOrEqual(100);
    const added = applyOwnerAdds(
      hook.edit,
      [{ id: "owner-visual-1", photo_id: PHOTO.id, word: "w19", ...at }],
      context,
    );
    if (!added.ok) throw new Error(added.reasons.join("; "));
    const settled = settleOwnerMove(
      added.edit,
      { id: "owner-visual-1", kind: "box", ...at },
      context,
    );
    if (!settled.ok) throw new Error(settled.reasons.join("; "));
    const { components } = build(
      settled.edit,
      hook.transcript,
      hook.headTrack,
      preset,
      context.measurer,
    );
    const card = components.find((component) => component.id === "owner-visual-1")!;
    const engine = components.find((component) => component.id === "visual-1")!;
    expect(ownerMoveProblems(components, ["owner-visual-1"])).toEqual([]);
    // Off the engine's card.
    const apart =
      card.x >= engine.x + engine.width ||
      engine.x >= card.x + card.width ||
      card.y >= engine.y + engine.height ||
      engine.y >= card.y + card.height;
    expect(apart).toBe(true);
    expect(Math.abs(card.height / card.width - 900 / 1600)).toBeLessThan(0.01);
  });
});

// A font pair change places the answer again (app_docs/font-pairs.md): the
// owner's pictures do not depend on the font, so they stay.
describe("what a relayout keeps of the owner's pictures", () => {
  const answer = {
    accents: [],
    questions: [],
    big_words: [],
    visuals: [{ from: hook.transcript.words[0]!.id, to: hook.transcript.words[5]!.id }],
    lists: [],
    word_fixes: [],
    hook: null,
  };
  const visual = (edit: Edit, id: string) => {
    const item = (edit.tracks.behind ?? []).find((entry) => entry.id === id);
    if (item?.kind !== "visual") throw new Error(`no visual ${id}`);
    return item;
  };
  const placeAnswer = async (current: Edit, pictures?: ReturnType<typeof ownerPictures>) => {
    const measurer = await nodeMeasurer();
    const made = editFromAnswer(
      current,
      answer,
      preset,
      hook.transcript,
      hook.headTrack,
      measurer,
      pictures,
    );
    if (!made.ok) throw new Error(made.reasons.join("; "));
    return made.edit;
  };
  const picture = { id: PHOTO.id, width: PHOTO.width, height: PHOTO.height };

  it("places a card with the photo the owner gave it, at the photo's aspect, and names it in the inputs", async () => {
    const standIn = await placeAnswer(hook.edit);
    expect(visual(standIn, "visual-1").image).toBeDefined();
    expect(standIn.inputs.photos).toBeUndefined();
    expect(ownerPictures(standIn).size).toBe(0);

    // The owner's swap, as a stored version holds it.
    const card = visual(standIn, "visual-1");
    const swapped: Edit = {
      ...standIn,
      inputs: { ...standIn.inputs, photos: [PHOTO.id] },
      tracks: {
        ...standIn.tracks,
        behind: [
          {
            id: card.id,
            kind: "visual",
            start: card.start,
            end: card.end,
            photo: picture,
            box: card.box,
          },
        ],
      },
    };
    expect([...ownerPictures(swapped)]).toEqual([["visual-1", picture]]);

    const again = await placeAnswer(swapped, ownerPictures(swapped));
    const placed = visual(again, "visual-1");
    expect(placed.photo).toEqual(picture);
    expect("image" in placed).toBe(false);
    expect(Math.abs(placed.box.height - (placed.box.width * 900) / 1600)).toBeLessThanOrEqual(1);
    expect(again.inputs.photos).toEqual([PHOTO.id]);

    // A new answer placed over that version (no pictures given) shows its
    // stand-in and names no photo: the old names are never carried.
    const fresh = await placeAnswer(swapped);
    expect(visual(fresh, "visual-1").image).toBe(card.image);
    expect(fresh.inputs.photos).toBeUndefined();
  });

  it("keeps the cards the owner added, as they were, after the engine's, each with its click", async () => {
    const standIn = await placeAnswer(hook.edit);
    const start = word("w10");
    const added = applyOwnerAdds(
      standIn,
      [{ id: "owner-visual-1", photo_id: PHOTO.id, word: start.id, x: 620, y: 420, width: 320 }],
      await contextOf(),
    );
    if (!added.ok) throw new Error(added.reasons.join("; "));
    const turned: Edit = {
      ...added.edit,
      tracks: {
        ...added.edit.tracks,
        behind: added.edit.tracks.behind!.map((item) =>
          item.id === "owner-visual-1" && item.kind === "visual" ? { ...item, rotation: 12 } : item,
        ),
      },
    };
    // An added card is no picture of the answer's cards.
    expect(ownerPictures(turned).size).toBe(0);

    const again = await placeAnswer(turned, ownerPictures(turned));
    expect(again.tracks.behind!.map((item) => item.id)).toEqual(["visual-1"]);
    const kept = keepOwnerAdds(turned, again, { transcript: hook.transcript, preset });
    expect(kept.tracks.behind!.map((item) => item.id)).toEqual(["visual-1", "owner-visual-1"]);
    expect(visual(kept, "owner-visual-1")).toEqual(visual(turned, "owner-visual-1"));
    expect(kept.inputs.photos).toEqual([PHOTO.id]);
    const clicks = (edit: Edit) =>
      edit.tracks.sounds.filter((sound) => sound.id === "click-owner-visual-1").length;
    expect(clicks(kept)).toBe(clicks(turned));
    const parsed = parseEdit(structuredClone(kept), preset, hook.transcript);
    expect(parsed.ok ? [] : parsed.reasons).toEqual([]);
    // Nothing added: the placed edit itself.
    expect(keepOwnerAdds(standIn, again, { transcript: hook.transcript, preset })).toBe(again);
  });
});
