import type { Box } from "@edit-issebya/edit";

export type ZoneId = "top" | "bottom" | "left" | "right" | "buttons";

// One covered rectangle, in percent of the frame.
export interface Zone {
  id: ZoneId;
  left: number;
  top: number;
  width: number;
  height: number;
}

// What the platforms' own interface covers outside `safe`: the full-width
// bands above and below it, the two side strips between them, and the button
// column's notch (`buttons`, a box inside `safe` at its lower-right corner),
// in percent of the frame so the layer scales with the player.
export function platformZones(
  frame: { width: number; height: number },
  safe: Box,
  buttons: Box,
): Zone[] {
  const x = (px: number) => (px / frame.width) * 100;
  const y = (px: number) => (px / frame.height) * 100;
  const middle = { top: y(safe.top), height: y(safe.bottom - safe.top) };
  return [
    { id: "top", left: 0, top: 0, width: 100, height: y(safe.top) },
    {
      id: "bottom",
      left: 0,
      top: y(safe.bottom),
      width: 100,
      height: y(frame.height - safe.bottom),
    },
    { id: "left", left: 0, width: x(safe.left), ...middle },
    { id: "right", left: x(safe.right), width: x(frame.width - safe.right), ...middle },
    {
      id: "buttons",
      left: x(buttons.left),
      top: y(buttons.top),
      width: x(buttons.right - buttons.left),
      height: y(buttons.bottom - buttons.top),
    },
  ];
}
