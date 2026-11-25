import type { Component } from "./base.ts";
import { Accent } from "./accent.ts";
import { Bigword } from "./bigword.ts";
import { Caption } from "./caption.ts";
import { Hook } from "./hook.ts";
import { List } from "./list.ts";
import type { ComponentName } from "./names.ts";
import { Question } from "./question.ts";
import { Visual } from "./visual.ts";

export type { ComponentName } from "./names.ts";

// One instance of each component's class. A name with no class does not compile.
export const COMPONENTS: Record<ComponentName, Component> = {
  HOOK: new Hook(),
  ACCENT: new Accent(),
  QUESTION: new Question(),
  BIGWORD: new Bigword(),
  VISUAL: new Visual(),
  LIST: new List(),
  CAPTION: new Caption(),
};

// The component a stored overlay is: the one that owns it (an overlay none owns is an accent, as
// the code before the classes had it).
export function componentOfOverlay(item: { id: string; kind: string }): ComponentName {
  for (const name of ["HOOK", "QUESTION", "ACCENT"] as const) {
    if (COMPONENTS[name].owns(item)) return name;
  }
  return "ACCENT";
}
