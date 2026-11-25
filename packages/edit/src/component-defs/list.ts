import { z } from "zod";
import {
  type AnswerContext,
  type AnswerField,
  type Pick,
  type Problem,
  type ReadBackContext,
  type Say,
} from "./answer.ts";
import { Component, type Stored } from "./base.ts";
import type { ListChoice, TransitionChoice } from "../engine-input.ts";
import type { TransitionItem } from "../schema.ts";
import { VARIANTS } from "../variants.ts";

// A numbered list of the speaker's points, one level per part.
export class List extends Component {
  readonly name = "LIST" as const;
  readonly looks = [VARIANTS["list/numbered"]];
  readonly order = 5;

  // The lists of the reel's numbered phrases, in reel order. Each list's items are numbered 1, 2,
  // ... in order; a list of one item shows no number. A list has at least one item.
  override readonly answer: AnswerField<"lists", ListChoice> = {
    field: "lists",
    itemId: "transition",
    schema: (ctx) =>
      z.array(
        z.strictObject({
          items: z
            .array(z.strictObject({ from: ctx.wordId, to: ctx.wordId, key_from: ctx.wordId }))
            .min(1),
        }),
      ),
    empty: () => [],
  };

  override get stored(): Stored {
    return { track: "transitions", kind: null, idPrefix: null };
  }

  // An item's phrase does not end before it starts, and its key phrase starts inside it.
  override validate(items: readonly unknown[], ctx: AnswerContext): Problem[] {
    const problems: Problem[] = [];
    (items as ListChoice[]).forEach((list, listIndex) => {
      list.items.forEach((item, index) => {
        const path = [this.answer.field, listIndex, "items", index];
        if (ctx.order.get(item.to)! < ctx.order.get(item.from)!) {
          problems.push({
            path: [...path, "to"],
            message: `ends on ${item.to}, before it starts on ${item.from}`,
          });
        }
        const key = ctx.order.get(item.key_from)!;
        if (key < ctx.order.get(item.from)! || key > ctx.order.get(item.to)!) {
          problems.push({
            path: [...path, "key_from"],
            message: `key phrase starts on ${item.key_from}, outside ${item.from} to ${item.to}`,
          });
        }
      });
    });
    return problems;
  }

  // An item's engine id counts the items of every list in reel order.
  override picks(answer: object): Pick[] {
    const lists = (answer as { lists?: ListChoice[] }).lists;
    const out: Pick[] = [];
    (Array.isArray(lists) ? lists : []).forEach((list, listIndex) => {
      list.items.forEach((item, position) => {
        out.push({
          ref: `lists[${listIndex}].items[${position}]`,
          item: `transition-${out.length + 1}`,
          from: item.from,
          to: item.to,
          list: listIndex,
          position,
        });
      });
    });
    return out;
  }

  // Each item reads back from its own words, its key phrase from its key word. The items placed
  // in one list (the same `list` number) read back as one list in reel order; a placed item with
  // no `list` reads back as a list of its own.
  override readBack(items: readonly TransitionItem[], ctx: ReadBackContext): ListChoice[] {
    const lists: ListChoice[] = [];
    const listOf = new Map<number, ListChoice>();
    for (const transition of items) {
      const item: TransitionChoice = {
        ...ctx.ends(transition.words),
        key_from: transition.key ?? transition.words[0]!,
      };
      if (transition.list === undefined) {
        lists.push({ items: [item] });
        continue;
      }
      let list = listOf.get(transition.list);
      if (!list) {
        list = { items: [] };
        listOf.set(transition.list, list);
        lists.push(list);
      }
      list.items.push(item);
    }
    return lists;
  }

  override trace(pick: Pick, say: Say): string {
    return `list ${pick.list! + 1}.${pick.position! + 1} "${say(pick.from, pick.to)}"`;
  }
}
