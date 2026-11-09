import type { TransitionItem } from "../schema.ts";

// Reads the transition layers and their level texts out of a built page. The
// goldens are compared byte for byte, so this checks what they hold.

type Layer = { id: string; levels: Record<string, string> };

const LAYER = /<div id="([^"]+)" class="clip layer"/g;
const LEVEL = /<div id="([^"]+)-(number|lead|key)" class="level [^"]*" style="[^"]*">(.*?)<\/div>/g;

export function transitionLayers(html: string): Layer[] {
  const levels = [...html.matchAll(LEVEL)];
  return [...html.matchAll(LAYER)].map(([, id]) => ({
    id: id!,
    levels: Object.fromEntries(
      levels
        .filter((match) => match[1] === id)
        .map((match) => [match[2]!, match[3]!.replaceAll("<br />", " ")]),
    ),
  }));
}

// A transition's level texts as the edit names them, in the reader's shape.
export function editTransitionLevels(transition: TransitionItem): Layer {
  const { number, lead, key } = transition.levels ?? {};
  const levels = Object.fromEntries(
    Object.entries({ number, lead, key }).flatMap(([name, item]) =>
      item ? [[name, item.text]] : [],
    ),
  );
  return { id: transition.id, levels };
}

// What the rethink-work-transitions golden holds, apart from its edit file.
export const TRANSITION_LEVELS: Layer[] = [
  { id: "transition-1", levels: { number: "1", lead: "they want", key: "fair pay" } },
  { id: "transition-2", levels: { number: "2", lead: "protected", key: "mental health" } },
];
