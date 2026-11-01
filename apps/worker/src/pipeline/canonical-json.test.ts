import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: null, e: "x" }], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,{"e":"x","f":null}]},"b":1}',
    );
  });

  it("gives the same text whatever the key order", () => {
    expect(canonicalJson({ x: 1, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: 1 }));
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("refuses values JSON would drop or change", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow("$.a is undefined");
    expect(() => canonicalJson({ a: [NaN] })).toThrow("$.a[0] is NaN");
    expect(() => canonicalJson(Infinity)).toThrow("is Infinity");
    expect(() => canonicalJson({ f: () => 1 })).toThrow("is function");
    expect(() => canonicalJson({ s: Symbol("s") })).toThrow("is symbol");
    expect(() => canonicalJson({ d: new Date(0) })).toThrow("not a plain object");
  });
});
