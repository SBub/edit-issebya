// JSON with object keys sorted by code point and no whitespace, so equal values
// always give equal text (the input of a fingerprint). Refuses what JSON would
// drop or change silently: undefined, functions, symbols, non-finite numbers and
// anything but plain objects, arrays, strings, finite numbers, booleans and null.
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${path} is ${value}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(`canonicalJson: ${path} is ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item, `${path}[${index}]`)).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`canonicalJson: ${path} is not a plain object`);
  }
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = keys.map(
    (key) =>
      `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], `${path}.${key}`)}`,
  );
  return `{${entries.join(",")}}`;
}
