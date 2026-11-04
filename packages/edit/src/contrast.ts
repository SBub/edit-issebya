// WCAG 2.x contrast, pure: the relative luminance of an sRGB colour and the
// contrast ratio of two luminances. The layout engine measures every text
// against the footage behind it with these; it never changes a colour.

function channel(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// The relative luminance (0 to 1) of an 8-bit sRGB pixel.
export function rgbLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// The relative luminance of a `#RRGGBB` colour (the edit format's one form).
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!match) throw new Error(`relativeLuminance: not a #RRGGBB colour: ${hex}`);
  return rgbLuminance(
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  );
}

// The lighter over the darker, each plus 0.05: 1 (equal) to 21 (white on black).
export function contrastRatio(a: number, b: number): number {
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

// A luminance as the byte the background map stores, and back.
export function luminanceByte(luminance: number): number {
  return Math.min(255, Math.max(0, Math.round(luminance * 255)));
}

export function byteLuminance(byte: number): number {
  return byte / 255;
}

// The luminance with the same contrast against black as against white: a
// text above it is light (a dark shadow separates it), below it dark.
const MID_LUMINANCE = Math.sqrt(1.05 * 0.05) - 0.05;

export function isLightText(color: string): boolean {
  return relativeLuminance(color) >= MID_LUMINANCE;
}
