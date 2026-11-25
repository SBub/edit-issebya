import { Component, type Stored } from "./base.ts";
import { VARIANTS } from "../variants.ts";

// A picture card for what the speaker is describing.
export class Visual extends Component {
  readonly name = "VISUAL" as const;
  readonly looks = [VARIANTS["visual/card"]];
  readonly order = 4;

  override get stored(): Stored {
    return { track: "behind", kind: "visual", idPrefix: null };
  }
}
