import { describe, expect, it } from "vitest";
import { CALL_FORM_TRACKED_FIELDS, invalidFields, trackedField } from "./call-form-events";

describe("trackedField", () => {
  it("knows the five form fields", () => {
    expect(CALL_FORM_TRACKED_FIELDS).toEqual(["name", "email", "socials", "terms", "newsletter"]);
    for (const field of CALL_FORM_TRACKED_FIELDS) expect(trackedField(field)).toBe(field);
  });

  it("is null for anything else", () => {
    expect(trackedField("")).toBeNull();
    expect(trackedField("password")).toBeNull();
  });
});

describe("invalidFields", () => {
  it("lists the fields with an error, in form order, and never the messages", () => {
    expect(invalidFields({ terms: "x", name: "y" })).toEqual(["name", "terms"]);
    expect(invalidFields({})).toEqual([]);
    expect(invalidFields({ email: undefined })).toEqual([]);
  });
});
