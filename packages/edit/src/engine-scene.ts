import type { Box, HeadTrack } from "./head-track.ts";
import { boundingBox, facesOver, LAYOUT_PADDING } from "./head-track.ts";
import type { Obstacle, PlaceScene } from "./engine-place.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { during, ms } from "./engine-timing.ts";

// THE SCENE (`specs/layout-engine.md`, "The scene"): the reel cut into moments
// at every element edge, each moment's robust faces, and the placer's scene
// over a span: the faces and the texts on screen with it.

// A text on screen as placed: its id (a text level's transition id), what a
// note calls it, its span and its box; `caption` for a caption (a `caption`
// obstacle to the placer, rule 2).
export interface Shown {
  id: string;
  what: string;
  start: number;
  end: number;
  box: Box;
  caption?: boolean;
}

export interface Moment {
  start: number;
  end: number;
  // The robust faces around the moment, unpadded (the placer pads them itself).
  faces: Box[];
  // Their bounding box, padded for text (`LAYOUT_PADDING`); null with no head.
  face: Box | null;
}

// The reel cut at every item edge; each moment's face is the bounding box of
// the robust faces around it.
export function sceneOf(
  edges: readonly number[],
  duration: number,
  headTrack: HeadTrack,
): Moment[] {
  const cuts = [...new Set([0, ms(duration), ...edges.map(ms)])]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);
  const moments: Moment[] = [];
  for (let index = 1; index < cuts.length; index += 1) {
    const start = cuts[index - 1]!;
    const end = cuts[index]!;
    const faces = facesOver(headTrack, start - 0.25, end + 0.25);
    const bounds = boundingBox(faces);
    const face = bounds && {
      ...bounds,
      left: bounds.left - LAYOUT_PADDING.left,
      right: bounds.right + LAYOUT_PADDING.right,
    };
    moments.push({ start, end, faces, face });
  }
  return moments;
}

const momentsOver = (scene: readonly Moment[], span: { start: number; end: number }) =>
  scene.filter((moment) => moment.start < span.end && span.start < moment.end);

// The unpadded robust faces of the moments over a span (the placer's scene).
function rawFacesDuring(scene: readonly Moment[], span: { start: number; end: number }): Box[] {
  return momentsOver(scene, span).flatMap((moment) => moment.faces);
}

// The placer's scene over a span: the unpadded robust faces of its moments and
// every text on screen with it as an obstacle, a `text` for a component and a
// `caption` for a caption placed before it (captions come last, so a component
// sees none).
export function placerScene(
  scene: readonly Moment[],
  shown: readonly Shown[],
  span: { start: number; end: number },
): PlaceScene {
  const obstacles: Obstacle[] = shown
    .filter((item) => during(item, span))
    .map((item): Obstacle => ({
      id: item.id,
      kind: item.caption ? "caption" : "text",
      box: item.box,
    }));
  return { faces: rawFacesDuring(scene, span), obstacles, safe: SAFE_ZONE };
}
