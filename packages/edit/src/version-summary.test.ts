import { describe, expect, it } from "vitest";
import type { ChecklistOutcome } from "./editorial.ts";
import type { EngineNote } from "./engine.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { DiffEntry, EditDiff } from "./version-diff.ts";
import {
  askedNotDone,
  checkSummary,
  parseSummaryAnswer,
  summaryTemplate,
} from "./version-summary.ts";

const preset = ISSEBYA_PRESET;
const diffOf = (items: DiffEntry[], rules: EditDiff["rules"] = []): EditDiff => ({ items, rules });
const say = (change_title: string, change_summary: string) => ({ change_title, change_summary });

const PHOTO_DROPPED: EngineNote = {
  item: "photo-1",
  action: "dropped",
  rule: "no-room",
  reason: "photo 1: every photo spot is under captions or the face from 1.00 s to 3.00 s",
};
const ASKED_PHOTO: ChecklistOutcome = {
  ask: "a photo behind me",
  wants: "one photo",
  fulfilled_by: ["photos[0]"],
  done: false,
  reason: "photo 1: every photo spot is under captions or the face from 1.00 s to 3.00 s",
};

const TITLE: DiffEntry = { kind: "title", action: "added", id: "title", text: "Rethink work" };
const TRANSITION: DiffEntry = { kind: "transition", action: "added", id: "transition-1" };
const FIX: DiffEntry = { kind: "caption", action: "changed", id: "cw0010", text: "Studio" };
const PHOTO: DiffEntry = {
  kind: "photo",
  action: "added",
  id: "photo-1",
  photo_id: "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14",
  text: "the kitchen",
};

describe("parseSummaryAnswer", () => {
  it("refuses extra keys, empty strings and over-long ones", () => {
    expect(parseSummaryAnswer(say("Photo added", "A photo shows.")).ok).toBe(true);
    expect(parseSummaryAnswer({ ...say("Photo added", "A photo."), extra: 1 }).ok).toBe(false);
    expect(parseSummaryAnswer(say("", "A photo.")).ok).toBe(false);
    expect(parseSummaryAnswer(say("x".repeat(61), "A photo.")).ok).toBe(false);
    expect(parseSummaryAnswer(say("Photo added", "x".repeat(301))).ok).toBe(false);
  });
});

describe("checkSummary", () => {
  it("refuses a summary naming a photo the engine dropped (2026-11-03 v4)", () => {
    const diff = diffOf([]);
    const notDone = askedNotDone([PHOTO_DROPPED], [ASKED_PHOTO]);
    const result = checkSummary(
      say("Photo added behind you", "A photo now shows behind you."),
      diff,
      preset,
      notDone,
    );
    expect(result).toEqual({
      ok: false,
      reasons: ["names a photo that is not in the saved difference"],
    });
  });

  it("refuses word ids, times, sizes and font names", () => {
    const diff = diffOf([TITLE]);
    for (const summary of [
      "The title now covers w0004.",
      "The title shows for 2.5 s.",
      "The title is 48px tall.",
      "The title is set in Golos Text.",
      "The title shows at 0:03.",
      "The title is now #FFFFFF.",
      "The title sits in the top spot.",
    ]) {
      expect(checkSummary(say("Title added", summary), diff, preset).ok, summary).toBe(false);
    }
  });

  it("accepts a summary naming only kinds in the difference", () => {
    const diff = diffOf([TITLE, TRANSITION]);
    expect(
      checkSummary(
        say("Title and fade added", "A title opens the reel and a soft fade marks the new topic."),
        diff,
        preset,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts photos switched off with a rule change and no item", () => {
    const diff = diffOf([], [{ rule: "photos", to: "off" }]);
    expect(
      checkSummary(say("Photos switched off", "No photos in this one."), diff, preset),
    ).toEqual({ ok: true });
  });
});

describe("summaryTemplate", () => {
  const template = (
    diff: EditDiff,
    record: EngineNote[] = [],
    checklist: ChecklistOutcome[] = [],
  ) => summaryTemplate(diff, record, checklist, preset);

  it("titles one kind by its change", () => {
    expect(template(diffOf([PHOTO])).title).toBe("Photo added");
    expect(template(diffOf([{ ...PHOTO, action: "removed" }])).title).toBe("Photo removed");
    expect(template(diffOf([{ ...PHOTO, action: "moved" }])).title).toBe("Photo moved");
    expect(template(diffOf([FIX])).title).toBe("Word fixed");
    expect(template(diffOf([{ kind: "caption", action: "moved", id: "captions" }])).title).toBe(
      "Captions adjusted",
    );
    expect(template(diffOf([], [{ rule: "photos", to: "off" }])).title).toBe("Photos switched off");
    expect(template(diffOf([PHOTO])).summary).toBe(
      'A photo now shows behind you while you say "the kitchen".',
    );
  });

  it("titles two kinds together and more as several things", () => {
    expect(template(diffOf([TITLE, TRANSITION])).title).toBe("Title and transition changed");
    const many = template(diffOf([TITLE, TRANSITION, FIX]));
    expect(many.title).toBe("Several things changed");
    expect(many.summary).toMatch(/, and a few smaller changes\.$/);
  });

  it("says whether a transition covers other words, moves slower or stays longer", () => {
    const covers: DiffEntry = {
      kind: "transition",
      action: "retimed",
      id: "transition-1",
      text: "we do AI has completely",
      was: "AI has completely",
    };
    expect(template(diffOf([covers])).summary).toBe(
      'The transition on "AI has completely" now covers "we do AI has completely".',
    );
    const slower: DiffEntry = {
      kind: "transition",
      action: "changed",
      id: "transition-1",
      text: "fair pay",
      change: "slower",
    };
    expect(template(diffOf([slower])).summary).toBe('The transition on "fair pay" moves slower.');
    expect(template(diffOf([{ ...slower, change: "stays longer" }])).summary).toBe(
      'The transition on "fair pay" stays longer.',
    );
    for (const entry of [covers, slower]) {
      const { title, summary } = template(diffOf([entry]));
      expect(`${title} ${summary}`).not.toMatch(/\b(?:pace|hold|levels)\b/);
    }
  });

  it("says nothing changed for an empty difference", () => {
    expect(template(diffOf([]))).toEqual({
      title: "No changes",
      summary: "Nothing in the reel changed.",
    });
  });

  it("says a requested photo did not fit, in plain words", () => {
    const result = template(diffOf([TITLE]), [PHOTO_DROPPED], [ASKED_PHOTO]);
    expect(result.summary).toContain(
      "The photo you asked for did not fit: there was no free room on screen.",
    );
    expect(result.summary).not.toMatch(/\d/);
  });

  it("always passes its own safeguard and the schema, with no em-dash", () => {
    const cases: [EditDiff, EngineNote[], ChecklistOutcome[]][] = [
      [diffOf([]), [], []],
      [diffOf([PHOTO]), [], []],
      [diffOf([TITLE, TRANSITION, FIX]), [], []],
      [diffOf([TITLE]), [PHOTO_DROPPED], [ASKED_PHOTO]],
      [diffOf([], [{ rule: "big_word", to: "off" }]), [], []],
      [diffOf([{ kind: "footage", action: "changed", id: "footage" }]), [], []],
      [
        diffOf([{ kind: "transition", action: "retimed", id: "t1", text: "fair pay", was: "pay" }]),
        [],
        [],
      ],
      [
        diffOf([
          { kind: "transition", action: "changed", id: "t1", text: "x", change: "usual hold" },
        ]),
        [],
        [],
      ],
      [
        diffOf([
          { kind: "accent", action: "added", id: "a1", text: "w0004 at 2 s" },
          { kind: "accent", action: "added", id: "a2", text: "photo" },
        ]),
        [],
        [],
      ],
    ];
    for (const [diff, record, checklist] of cases) {
      const { title, summary } = template(diff, record, checklist);
      const answer = { change_title: title, change_summary: summary };
      expect(parseSummaryAnswer(answer).ok, title).toBe(true);
      expect(
        checkSummary(answer, diff, preset, askedNotDone(record, checklist)),
        `${title}: ${summary}`,
      ).toEqual({ ok: true });
      expect(title.split(" ").length).toBeGreaterThanOrEqual(2);
      expect(title.split(" ").length).toBeLessThanOrEqual(5);
      expect(`${title}${summary}`).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
