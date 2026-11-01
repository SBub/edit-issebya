// The <hyperframes-player> custom element in JSX, with the attributes the
// studio's preview sets. The element is registered on the client only, by
// importing @hyperframes/player inside an effect.
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { HyperframesPlayer } from "@hyperframes/player";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hyperframes-player": DetailedHTMLProps<
        HTMLAttributes<HyperframesPlayer>,
        HyperframesPlayer
      > & {
        srcdoc?: string;
        width?: string;
        height?: string;
        "disable-click-to-play"?: string;
        "assets-loading-ui"?: "player" | "none";
      };
    }
  }
}
