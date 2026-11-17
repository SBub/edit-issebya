import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { photoIdsOf, photoPath, withPhotoInputs } from "./photos.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { type BehindVisualItem, type Edit, parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// A VISUAL showing one of the owner's library photos (app_docs/photo-library.md).
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const PHOTO = { id: "11111111-2222-4333-8444-555555555555", width: 1600, height: 900 };
const OTHER = { id: "00000000-2222-4333-8444-555555555555", width: 900, height: 1600 };

function visualOf(edit: Edit): BehindVisualItem {
  const item = edit.tracks.behind!.find((entry) => entry.id === "visual-1");
  if (item?.kind !== "visual") throw new Error("no visual-1");
  return item;
}

// The fixture with its VISUAL showing `photo` in place of its stand-in, and a
// second card with `second` over the same moment when given.
function withPhotos(photo = PHOTO, second?: typeof PHOTO): Edit {
  const visual = visualOf(hook.edit);
  const own = { ...visual, photo };
  delete own.image;
  const behind = hook.edit.tracks.behind!.map((item) => (item.id === "visual-1" ? own : item));
  if (second) {
    behind.push({
      ...own,
      id: "owner-visual-1",
      photo: second,
      box: { x: 600, y: 900, width: 300, height: 533 },
    });
  }
  return withPhotoInputs({ ...hook.edit, tracks: { ...hook.edit.tracks, behind } });
}

function parse(json: unknown) {
  return parseEdit(json, ISSEBYA_PRESET, hook.transcript);
}

describe("a VISUAL showing a library photo", () => {
  it("names its photos in the inputs, sorted, each once", () => {
    const edit = withPhotos(PHOTO, OTHER);
    expect(edit.inputs.photos).toEqual([OTHER.id, PHOTO.id]);
    expect(photoIdsOf(edit)).toEqual([OTHER.id, PHOTO.id]);
    expect(parse(edit).ok).toBe(true);
    // No photo: no field.
    expect("photos" in withPhotoInputs(hook.edit).inputs).toBe(false);
  });

  it("refuses a stand-in and a photo on one card, and inputs that do not name the photos shown", () => {
    const edit = withPhotos();
    const both = {
      ...edit,
      tracks: {
        ...edit.tracks,
        behind: edit.tracks.behind!.map((item) =>
          item.id === "visual-1" ? { ...item, image: "assets/visuals/visual-1.jpg" } : item,
        ),
      },
    };
    const refusedBoth = parse(both);
    expect(refusedBoth.ok).toBe(false);
    if (!refusedBoth.ok) {
      expect(refusedBoth.reasons.join("; ")).toMatch(/a stand-in or a photo, never both/);
    }
    const unnamed = parse({ ...edit, inputs: { ...edit.inputs, photos: [] } });
    expect(unnamed.ok).toBe(false);
    const extra = parse({ ...hook.edit, inputs: { ...hook.edit.inputs, photos: [PHOTO.id] } });
    expect(extra.ok).toBe(false);
    const notUuid = parse({ ...edit, inputs: { ...edit.inputs, photos: ["photo"] } });
    expect(notUuid.ok).toBe(false);
  });

  it("draws the photo's large copy filling the card, and names it on the full and the front page", async () => {
    const measurer = await nodeMeasurer();
    const edit = withPhotos();
    const full = build(edit, hook.transcript, hook.headTrack, ISSEBYA_PRESET, measurer);
    expect(full.html).toContain(`<img src="${photoPath(PHOTO.id)}" alt="">`);
    expect(full.html).not.toContain("assets/visuals/visual-1.jpg");
    expect(full.assets).toContainEqual({
      path: `photos/${PHOTO.id}.jpg`,
      role: "photo",
      ref: null,
      photoId: PHOTO.id,
    });
    const front = build(edit, hook.transcript, hook.headTrack, ISSEBYA_PRESET, measurer, {
      layer: "front",
    });
    expect(front.assets.map((asset) => asset.role)).toContain("photo");
    const behind = build(edit, hook.transcript, hook.headTrack, ISSEBYA_PRESET, measurer, {
      layer: "behind",
    });
    expect(behind.assets.map((asset) => asset.role)).not.toContain("photo");
    expect(full.components.find((component) => component.id === "visual-1")).toMatchObject({
      component: "VISUAL",
      picture: PHOTO.id,
    });
  });

  it("draws two cards at the same moment on the cards' track, the later one on top", async () => {
    const measurer = await nodeMeasurer();
    const edit = withPhotos(PHOTO, OTHER);
    const { html, components } = build(
      edit,
      hook.transcript,
      hook.headTrack,
      ISSEBYA_PRESET,
      measurer,
    );
    const first = html.indexOf('<div id="visual-1"');
    const second = html.indexOf('<div id="owner-visual-1"');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(html).toMatch(/<div id="visual-1"[^>]*data-track-index="30"/);
    expect(html).toMatch(/<div id="owner-visual-1"[^>]*data-track-index="30"/);
    const cards = components.filter((component) => component.component === "VISUAL");
    expect(cards.map((card) => card.id)).toEqual(["visual-1", "owner-visual-1"]);
    expect(cards[0]!.start).toBe(cards[1]!.start);
  });
});
