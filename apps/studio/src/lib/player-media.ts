import type { HyperframesPlayer } from "@hyperframes/player";

// The one place that reads the player's internals, read only; revisit on
// every bump of @hyperframes/player (pinned at 0.8.222, the worker's
// hyperframes). In its default same-origin mode the composition's own
// <video id="footage"> and <video id="cutout"> play inside the player's
// iframe. The player also mirrors timed, unmuted media (the footage) into
// parent-frame proxies, which take over the sound only when it promotes audio
// to the parent frame (`_audioOwner === "parent"`, when autoplay in the iframe
// is blocked). The proxies of the composition's videos then gate the clock
// too. Nothing here ever assigns to the player or its media.

// What a media element in either frame offers (instanceof fails across frames).
function isMedia(node: Element | null): node is HTMLMediaElement {
  return node !== null && (node.tagName === "VIDEO" || node.tagName === "AUDIO");
}

// The elements whose readiness gates the player's clock.
export function playingMedia(player: HyperframesPlayer): HTMLMediaElement[] {
  const doc = player.iframeElement?.contentDocument;
  if (!doc) return [];
  const media = ["footage", "cutout"].map((id) => doc.getElementById(id)).filter(isMedia);
  if (player._audioOwner === "parent") {
    for (const entry of player._parentMedia) {
      if (entry.source && media.includes(entry.source)) media.push(entry.el);
    }
  }
  return media;
}
