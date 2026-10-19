import { describe, expect, it } from "vitest";
import {
  CALL_REQUEST_MESSAGES,
  MAX_SOCIALS,
  normaliseLink,
  parseCallRequest,
  toCheckoutMetadata,
} from "./call-request";

const VALID = { name: "Ana", email: "ana@example.com", socials: [], terms: true };

function errorsFor(input: Record<string, unknown>) {
  const result = parseCallRequest(input);
  return result.ok ? {} : result.errors;
}

describe("parseCallRequest", () => {
  it("accepts name, email and terms with no social links", () => {
    expect(parseCallRequest({ ...VALID, name: "  Ana  " })).toEqual({
      ok: true,
      value: { name: "Ana", email: "ana@example.com", socials: [], terms: true },
    });
  });

  it("accepts the checkbox's form value", () => {
    expect(parseCallRequest({ ...VALID, terms: "on" }).ok).toBe(true);
  });

  it("reports name, email and terms on an empty object, never socials", () => {
    expect(errorsFor({})).toEqual({
      name: CALL_REQUEST_MESSAGES.required,
      email: CALL_REQUEST_MESSAGES.required,
      terms: CALL_REQUEST_MESSAGES.terms,
    });
  });

  it("treats empty, whitespace-only and non-string values as missing", () => {
    for (const name of ["", "   ", 42, ["Ana"]]) {
      expect(errorsFor({ ...VALID, name }).name).toBe(CALL_REQUEST_MESSAGES.required);
    }
  });

  it("checks the email shape", () => {
    for (const email of ["ana", "ana@example", "a b@example.com"]) {
      expect(errorsFor({ ...VALID, email }).email).toBe(CALL_REQUEST_MESSAGES.email);
    }
    expect(errorsFor({ ...VALID, email: "ana@example.com" }).email).toBeUndefined();
  });

  it("requires the terms to be accepted", () => {
    for (const terms of [false, "", "off", "true", 1, undefined]) {
      expect(errorsFor({ ...VALID, terms }).terms).toBe(CALL_REQUEST_MESSAGES.terms);
    }
  });

  it("drops empty social rows and adds https:// where it is missing", () => {
    const result = parseCallRequest({
      ...VALID,
      socials: ["", "instagram.com/ana", "  ", "http://ana.example.com/x"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...VALID,
        socials: ["https://instagram.com/ana", "http://ana.example.com/x"],
      },
    });
  });

  it("rejects a social entry that is not a web address", () => {
    for (const link of ["ana", "ftp://example.com", "javascript:alert(1)", "https://localhost"]) {
      expect(errorsFor({ ...VALID, socials: [link] }).socials).toBe(CALL_REQUEST_MESSAGES.url);
    }
  });

  it(`reads at most ${MAX_SOCIALS} social rows`, () => {
    const many = Array.from({ length: MAX_SOCIALS + 5 }, (_, i) => `x${i}.com`);
    const result = parseCallRequest({ ...VALID, socials: many });
    expect(result.ok && result.value.socials.length).toBe(MAX_SOCIALS);
  });

  it("caps the name and the joined socials at 500 characters", () => {
    expect(errorsFor({ ...VALID, name: "a".repeat(501) }).name).toBe(CALL_REQUEST_MESSAGES.tooLong);
    const long = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}${"a".repeat(100)}`);
    expect(errorsFor({ ...VALID, socials: long }).socials).toBe(CALL_REQUEST_MESSAGES.tooLong);
  });

  it("uses a distinct message for each rule", () => {
    expect(new Set(Object.values(CALL_REQUEST_MESSAGES)).size).toBe(5);
  });
});

describe("normaliseLink", () => {
  it("keeps http(s) links and completes bare hosts", () => {
    expect(normaliseLink("https://tiktok.com/@ana")).toBe("https://tiktok.com/@ana");
    expect(normaliseLink("linkedin.com/in/ana")).toBe("https://linkedin.com/in/ana");
    expect(normaliseLink("mailto:ana@example.com")).toBeNull();
  });
});

describe("toCheckoutMetadata", () => {
  it("joins socials one per line and records the terms acceptance", () => {
    expect(
      toCheckoutMetadata({ ...VALID, socials: ["https://a.com/", "https://b.com/"], terms: true }),
    ).toEqual({
      name: "Ana",
      email: "ana@example.com",
      socials: "https://a.com/\nhttps://b.com/",
      terms_accepted: "true",
    });
  });
});
