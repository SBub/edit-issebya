import { Component, type Stored } from "./base.ts";
import { VARIANTS } from "../variants.ts";

// One or two words shown large behind the speaker.
export class Bigword extends Component {
  readonly name = "BIGWORD" as const;
  readonly looks = [VARIANTS["bigword/behind"]];
  readonly order = 3;

  override get stored(): Stored {
    return { track: "behind", kind: "word", idPrefix: null };
  }
}
