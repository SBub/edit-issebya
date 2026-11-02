import type { HyperframesPlayer } from "@hyperframes/player";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

// <hyperframes-player> in JSX (React 19 reads custom-element props as
// attributes unless the element has a property of that name).
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hyperframes-player": DetailedHTMLProps<
        HTMLAttributes<HyperframesPlayer>,
        HyperframesPlayer
      > & {
        width?: string;
        height?: string;
        srcdoc?: string;
        "disable-click-to-play"?: string;
        "assets-loading-ui"?: "player" | "none";
        "no-load-timeout"?: string;
      };
    }
  }
}
