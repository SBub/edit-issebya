import { Component, type Stored } from "./base.ts";
import { VARIANTS } from "../variants.ts";
import { QUESTION_PREFIX } from "../question.ts";

// A question the speaker puts to the viewer, shown word by word.
export class Question extends Component {
  readonly name = "QUESTION" as const;
  readonly looks = [VARIANTS["question/word-by-word"]];
  readonly order = 2;

  // Stored under the accent kind; its id prefix tells it apart.
  override get stored(): Stored {
    return { track: "overlays", kind: "accent", idPrefix: QUESTION_PREFIX };
  }
}
