// Synthetic background maps for the tests and the readable golden: each cell
// painted by its centre in frame pixels and the frame's time.
import { BACKGROUND_GRID, type BackgroundMap } from "../background.ts";
import { luminanceByte, relativeLuminance } from "../contrast.ts";

export function backgroundMapOf(
  frame: { width: number; height: number },
  duration: number,
  paint: (x: number, y: number, t: number) => string,
  grid: { everySeconds: number; columns: number; rows: number } = BACKGROUND_GRID,
): BackgroundMap {
  const { everySeconds, columns, rows } = grid;
  const cellWidth = frame.width / columns;
  const cellHeight = frame.height / rows;
  const count = Math.floor(duration / everySeconds + 1e-9) + 1;
  const frames: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = index * everySeconds;
    let text = "";
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const color = paint((col + 0.5) * cellWidth, (row + 0.5) * cellHeight, t);
        text += String.fromCharCode(luminanceByte(relativeLuminance(color)));
      }
    }
    frames.push(btoa(text));
  }
  return { version: 1, everySeconds, columns, rows, frames };
}
