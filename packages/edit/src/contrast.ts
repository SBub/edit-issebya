// WCAG 2 contrast between two `#RRGGBB` colours: the relative luminance of
// each, then (lighter + 0.05) / (darker + 0.05), from 1 (the same colour) to
// 21 (white on black).
export const MIN_LARGE_TEXT_CONTRAST = 3;

function luminance(color: string): number {
  const linear = (at: number) => {
    const value = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}
