import { Component, type StoredItem } from "./base.ts";
import { VARIANTS } from "../variants.ts";
import { QUESTION_PREFIX } from "../question.ts";

// A short phrase worth emphasising, shown above the speaker's head.
export class Accent extends Component {
  readonly name = "ACCENT" as const;
  readonly looks = [VARIANTS["accent/above-head"]];
  readonly order = 1;

  // A question is stored as an accent with a `question-` id.
  override owns(item: StoredItem): boolean {
    return super.owns(item) && !item.id.startsWith(QUESTION_PREFIX);
  }
}
