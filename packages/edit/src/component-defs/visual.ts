import { z } from "zod";
import {
  type AnswerField,
  PLAIN_LINE,
  type ReadBackContext,
  type Pick,
  type Say,
  phraseAnswer,
} from "./answer.ts";
import { Component, type Stored } from "./base.ts";
import type { VisualChoice } from "../engine-input.ts";
import type { BehindItem } from "../schema.ts";
import { VARIANTS } from "../variants.ts";

// A visual's description: a short plain phrase, at most this many words.
const VISUAL_WORDS = 8;

// A visual's description: what the frame would show, in a few plain words. It is never shown on
// screen; the schema, not the layout, checks its length.
function descriptionSchema() {
  return z
    .string()
    .min(1)
    .max(80, { message: "a visual description has at most 80 characters" })
    .regex(PLAIN_LINE, { message: "a visual description is one line of plain text" })
    .refine((text) => /[\p{L}\p{N}]/u.test(text), { message: "a visual description needs words" })
    .refine((text) => text.trim().split(/\s+/).length <= VISUAL_WORDS, {
      message: `a visual description has at most ${VISUAL_WORDS} words`,
    });
}

// A picture card for what the speaker is describing.
export class Visual extends Component {
  readonly name = "VISUAL" as const;
  readonly looks = [VARIANTS["visual/card"]];
  readonly order = 4;
  // An empty frame over its words, with what it would show.
  override readonly answer: AnswerField<"visuals", VisualChoice> = phraseAnswer(
    "visuals",
    "visual",
    () => ({
      description: descriptionSchema(),
    }),
  );

  override get stored(): Stored {
    return { track: "behind", kind: "visual", idPrefix: null };
  }

  override readBack(items: readonly BehindItem[], ctx: ReadBackContext): VisualChoice[] {
    const out: VisualChoice[] = [];
    for (const item of items) {
      const ids = ctx.under(item);
      if (ids.length === 0 || item.kind !== "visual") continue;
      const { description } = item;
      out.push({ ...ctx.ends(ids), ...(description ? { description } : {}) });
    }
    return out;
  }

  override trace(pick: Pick, say: Say): string {
    return `visual "${pick.description ?? ""}" on "${say(pick.from, pick.to)}"`;
  }
}
