import { Component } from "./base.ts";
import { VARIANTS } from "../variants.ts";

// The one written line at the start of the reel, typed letter by letter (its own AI call).
export class Hook extends Component {
  readonly name = "HOOK" as const;
  readonly looks = [VARIANTS["hook/typed"]];
  readonly order = 0;
}
