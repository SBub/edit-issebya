import type {
  AnswerContext,
  AnswerField,
  Pick,
  Placed,
  Problem,
  ReadBackContext,
  Say,
} from "./answer.ts";
import type { ComponentName } from "./names.ts";
import type { Variant } from "../variants.ts";

// Where a placed component is stored in a version: the track, and for an overlay or a behind item
// its `kind` and an id prefix when that tells it from another component stored the same way. A
// stored name never changes: saved versions keep reading.
export interface Stored {
  track: "overlays" | "behind" | "transitions" | "captions";
  kind: string | null;
  idPrefix: string | null;
}

// A stored item as far as ownership is concerned.
export interface StoredItem {
  id: string;
  kind?: string;
}

// The template every component fills in. A subclass sets `name` and `looks` and changes only what
// differs from these defaults. A default that depends on `name` is a getter or a method.
export abstract class Component {
  abstract readonly name: ComponentName;

  // How it appears. The first is the default.
  abstract readonly looks: readonly Variant[];

  // The look a pick gets when nothing chooses another.
  get defaultLook(): Variant {
    return this.looks[0]!;
  }

  // Where a placed one is stored: an overlay whose kind is the lower-case name.
  get stored(): Stored {
    return { track: "overlays", kind: this.name.toLowerCase(), idPrefix: null };
  }

  // Who is placed first when two start at the same moment (the hook, then the accents, the
  // questions, the big words, the visuals, the lists; the captions come last).
  abstract readonly order: number;

  // True when a stored item is a placed one of this component.
  owns(item: StoredItem): boolean {
    const { kind, idPrefix } = this.stored;
    if (kind !== null && item.kind !== kind) return false;
    return idPrefix === null || item.id.startsWith(idPrefix);
  }

  // The curator's part of this component in the answer: the field the AI fills and its schema.
  // None when the curator does not pick it (the hook has its own call; captions come from the
  // transcript).
  readonly answer: AnswerField | null = null;

  // Extra rules beyond the schema, for the picks of this component in an answer (none when it has
  // no `answer`). Each problem names the pick and says why. The plain rule: a phrase does not end
  // before it starts.
  validate(items: readonly unknown[], ctx: AnswerContext): Problem[] {
    const field = this.answer?.field ?? this.name;
    const problems: Problem[] = [];
    (items as { from: string; to: string }[]).forEach((item, index) => {
      if (ctx.order.get(item.to)! < ctx.order.get(item.from)!) {
        problems.push({
          path: [field, index, "to"],
          message: `ends on ${item.to}, before it starts on ${item.from}`,
        });
      }
    });
    return problems;
  }

  // This component's picks of an answer, each with its place in it and the id the engine places it
  // under. The answer may be an older one that lacks the field.
  picks(answer: object): Pick[] {
    const shape = this.answer;
    if (!shape) return [];
    const items = (answer as Record<string, unknown>)[shape.field];
    if (!Array.isArray(items)) return [];
    return (items as { from: string; to: string; description?: string }[]).map((item, index) => ({
      ref: `${shape.field}[${index}]`,
      item: `${shape.itemId}-${index + 1}`,
      from: item.from,
      to: item.to,
      ...(item.description === undefined ? {} : { description: item.description }),
    }));
  }

  // The opposite of `picks`: this component's stored items of a version (the ones it owns, in
  // order) read back as its picks of the answer, each by the words under it. An item no word is
  // spoken under is left out.
  readBack(items: readonly Placed[], ctx: ReadBackContext): unknown[] {
    const out: unknown[] = [];
    for (const item of items) {
      const ids = "words" in item && item.words ? item.words : ctx.under(item);
      if (ids.length > 0) out.push(ctx.ends(ids));
    }
    return out;
  }

  // One line for the decision trace: what the curator proposed, in words.
  trace(pick: Pick, say: Say): string {
    return `${this.name.toLowerCase()} "${say(pick.from, pick.to)}"`;
  }
}
