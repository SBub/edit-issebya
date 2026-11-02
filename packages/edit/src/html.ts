// Text and number formatting for the built page: fixed rules so the same
// edit gives the same bytes in every environment.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

// A pixel value: a rounded integer, never `-0`.
export function px(n: number): string {
  const rounded = Math.round(n);
  return String(rounded === 0 ? 0 : rounded);
}

// Seconds to the millisecond, always three decimals, never `-0.000`.
export function sec(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  return (rounded === 0 ? 0 : rounded).toFixed(3);
}

// A gain in dB as HyperFrames' linear `data-volume`, four decimals.
export function volume(gainDb: number): string {
  return (10 ** (gainDb / 20)).toFixed(4);
}

// A JavaScript string literal for an element selector (ids are checked by the
// schema, so this is belt and braces).
export function selector(id: string): string {
  return JSON.stringify(`#${id}`);
}

// Attributes in the given order, values escaped.
export function attrs(pairs: readonly (readonly [string, string | null])[]): string {
  return pairs
    .map(([name, value]) => (value === null ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
    .join("");
}
