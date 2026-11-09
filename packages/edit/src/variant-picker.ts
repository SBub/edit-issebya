import type { EngineInput } from "./engine-input.ts";
import type { EngineComponent } from "./engine-note.ts";
import { VARIANTS, type Variant } from "./variants.ts";

// The variant picker (`specs/layout-engine.md`, "Writing a variant"): each pick
// of the engine input gets its entry from `variants.ts`. One entry per
// component for now, so a pick's entry is its component's; a later pick (an
// accent placed at the bottom, say) chooses here, never in the engine.

// The entry a component's pick places with. Total over the components: a new
// component fails to compile until it is named here.
export function variantOf(component: EngineComponent): Variant {
  switch (component) {
    case "HOOK":
      return VARIANTS["hook/written-line"];
    case "ACCENT":
      return VARIANTS["accent/above-head"];
    case "QUESTION":
      return VARIANTS["question/as-accent"];
    case "BIGWORD":
      return VARIANTS["bigword/behind"];
    case "VISUAL":
      return VARIANTS["visual/card"];
    case "LIST":
      return VARIANTS["list/numbered"];
    case "CAPTION":
      return VARIANTS["caption/default"];
  }
}

// The picked entry of each component the answer places, plus the captions
// (always placed, from the transcript, whatever the answer holds). A component
// the answer has no pick of is absent.
export type PickedVariants = ReadonlyMap<EngineComponent, Variant>;

// Each pick of `input` to its entry: the hook when there is one, each kind of
// pick the answer holds, and the captions.
export function pickVariants(input: EngineInput): PickedVariants {
  const picked = new Map<EngineComponent, Variant>();
  const pick = (component: EngineComponent) => picked.set(component, variantOf(component));
  if (input.hook) pick("HOOK");
  if (input.accents.length > 0) pick("ACCENT");
  if (input.questions.length > 0) pick("QUESTION");
  if (input.big_words.length > 0) pick("BIGWORD");
  if (input.visuals.length > 0) pick("VISUAL");
  if (input.lists.length > 0) pick("LIST");
  pick("CAPTION");
  return picked;
}
