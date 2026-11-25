// The one list of component names. A component is a meaning the curator picks (or, for CAPTION,
// the transcript places). The stored names (answer fields, dataset keys, storage kinds) are not
// these: each is written once, beside the name it maps to, in that component's class.
export const COMPONENT_NAMES = [
  "HOOK",
  "ACCENT",
  "QUESTION",
  "BIGWORD",
  "VISUAL",
  "LIST",
  "CAPTION",
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];
