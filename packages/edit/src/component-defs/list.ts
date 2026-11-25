import { Component, type Stored } from "./base.ts";
import { VARIANTS } from "../variants.ts";

// A numbered list of the speaker's points, one level per part.
export class List extends Component {
  readonly name = "LIST" as const;
  readonly looks = [VARIANTS["list/numbered"]];
  readonly order = 5;

  override get stored(): Stored {
    return { track: "transitions", kind: null, idPrefix: null };
  }
}
