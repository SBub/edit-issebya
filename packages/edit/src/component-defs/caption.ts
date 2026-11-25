import { Component, type Stored } from "./base.ts";
import { VARIANTS } from "../variants.ts";

// The spoken words, shown as captions (placed from the transcript, not picked).
export class Caption extends Component {
  readonly name = "CAPTION" as const;
  readonly looks = [VARIANTS["caption/default"]];
  readonly order = 6;

  override get stored(): Stored {
    return { track: "captions", kind: null, idPrefix: null };
  }
}
