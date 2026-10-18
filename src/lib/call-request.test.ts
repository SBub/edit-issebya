import { describe, expect, it } from "vitest";
import { CALL_REQUEST_FIELDS, CALL_REQUEST_MESSAGES, parseCallRequest } from "./call-request";

const VALID = {
  name: "Ana",
  email: "ana@example.com",
  company_role: "Acme, founder",
  content_link: "https://example.com/me",
  reels_purpose: "Grow my audience",
  call_times: "weekdays 10:00 to 13:00",
};

function errorsFor(input: Record<string, unknown>) {
  const result = parseCallRequest(input);
  return result.ok ? {} : result.errors;
}

describe("parseCallRequest", () => {
  it("accepts a complete request and trims every value", () => {
    const result = parseCallRequest({ ...VALID, name: "  Ana  " });
    expect(result).toEqual({ ok: true, value: VALID });
  });

  it("reports all six fields as required on an empty object", () => {
    const errors = errorsFor({});
    expect(Object.keys(errors)).toEqual([...CALL_REQUEST_FIELDS]);
    for (const field of CALL_REQUEST_FIELDS) {
      expect(errors[field]).toBe(CALL_REQUEST_MESSAGES.required);
    }
  });

  it("treats empty, whitespace-only and non-string values as missing", () => {
    expect(errorsFor({ ...VALID, name: "" }).name).toBe(CALL_REQUEST_MESSAGES.required);
    expect(errorsFor({ ...VALID, name: "   " }).name).toBe(CALL_REQUEST_MESSAGES.required);
    expect(errorsFor({ ...VALID, name: 42 }).name).toBe(CALL_REQUEST_MESSAGES.required);
    expect(errorsFor({ ...VALID, name: ["Ana"] }).name).toBe(CALL_REQUEST_MESSAGES.required);
  });

  it("checks the email shape", () => {
    expect(errorsFor({ ...VALID, email: "ana" }).email).toBe(CALL_REQUEST_MESSAGES.email);
    expect(errorsFor({ ...VALID, email: "ana@example" }).email).toBe(CALL_REQUEST_MESSAGES.email);
    expect(errorsFor({ ...VALID, email: "a b@example.com" }).email).toBe(
      CALL_REQUEST_MESSAGES.email,
    );
    expect(errorsFor({ ...VALID, email: "ana@example.com" }).email).toBeUndefined();
  });

  it("accepts only http(s) links", () => {
    for (const link of ["example.com", "ftp://example.com", "javascript:alert(1)"]) {
      expect(errorsFor({ ...VALID, content_link: link }).content_link).toBe(
        CALL_REQUEST_MESSAGES.url,
      );
    }
    expect(
      errorsFor({ ...VALID, content_link: "http://example.com" }).content_link,
    ).toBeUndefined();
    expect(
      errorsFor({ ...VALID, content_link: "https://example.com" }).content_link,
    ).toBeUndefined();
  });

  it("caps every field at 500 characters after trimming", () => {
    expect(errorsFor({ ...VALID, reels_purpose: "a".repeat(500) }).reels_purpose).toBeUndefined();
    expect(
      errorsFor({ ...VALID, reels_purpose: ` ${"a".repeat(500)} ` }).reels_purpose,
    ).toBeUndefined();
    expect(errorsFor({ ...VALID, reels_purpose: "a".repeat(501) }).reels_purpose).toBe(
      CALL_REQUEST_MESSAGES.tooLong,
    );
  });

  it("uses a distinct message for each rule", () => {
    expect(new Set(Object.values(CALL_REQUEST_MESSAGES)).size).toBe(4);
  });
});
