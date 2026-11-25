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
}
