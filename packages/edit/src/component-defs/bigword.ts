import {
  type AnswerContext,
  type AnswerField,
  type Problem,
  type ReadBackContext,
  phraseAnswer,
} from "./answer.ts";
import { Component, type Stored } from "./base.ts";
import type { BigWordChoice } from "../engine-input.ts";
import { cleanWord } from "../preset.ts";
import { BEHIND_WORD, type BehindItem } from "../schema.ts";
import { VARIANTS } from "../variants.ts";

// One or two words shown large behind the speaker.
export class Bigword extends Component {
  readonly name = "BIGWORD" as const;
  readonly looks = [VARIANTS["bigword/behind"]];
  readonly order = 3;
  override readonly answer: AnswerField<"big_words", BigWordChoice> = phraseAnswer(
    "big_words",
    "big-word",
  );

  override get stored(): Stored {
    return { track: "behind", kind: "word", idPrefix: null };
  }

  // One or two consecutive words, each one plain word of at most 24 letters.
  override validate(items: readonly unknown[], ctx: AnswerContext): Problem[] {
    const problems: Problem[] = [];
    (items as BigWordChoice[]).forEach((big, index) => {
      const path = [this.answer.field, index, "to"];
      const from = ctx.order.get(big.from)!;
      const to = ctx.order.get(big.to)!;
      if (to < from) {
        problems.push({ path, message: `ends on ${big.to}, before it starts on ${big.from}` });
        return;
      }
      if (to - from > 1) {
        problems.push({
          path,
          message: `${big.from} to ${big.to} spans ${to - from + 1} words; a big word is one or two consecutive words`,
        });
        return;
      }
      // Each word is checked on its own.
      ctx.ids.slice(from, to + 1).forEach((id) => {
        const text = cleanWord(ctx.words.get(id)?.text ?? "", ctx.preset);
        if (!BEHIND_WORD.test(text)) {
          problems.push({
            path,
            message: `${id} (${JSON.stringify(text)}) is not one plain word of at most 24 letters`,
          });
        }
      });
    });
    return problems;
  }

  // The stored text is one or two words joined by a space; the span starts on the first word that
  // reads as its first part, else on the first word.
  override readBack(items: readonly BehindItem[], ctx: ReadBackContext): BigWordChoice[] {
    const byId = new Map(ctx.transcript.words.map((word) => [word.id, word]));
    const out: BigWordChoice[] = [];
    for (const item of items) {
      const ids = ctx.under(item);
      if (ids.length === 0 || item.kind !== "word") continue;
      const parts = item.text.toLowerCase().split(" ");
      const readsAs = (index: number, part: string) =>
        cleanWord(byId.get(ids[index]!)!.text, ctx.preset).toLowerCase() === part;
      const found = ids.findIndex(
        (_, index) =>
          readsAs(index, parts[0]!) &&
          (parts.length === 1 || (index + 1 < ids.length && readsAs(index + 1, parts[1]!))),
      );
      const at = Math.max(0, found);
      out.push({ from: ids[at]!, to: ids[Math.min(at + parts.length - 1, ids.length - 1)]! });
    }
    return out;
  }
}
