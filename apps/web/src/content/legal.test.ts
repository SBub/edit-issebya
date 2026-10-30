import { describe, expect, it } from "vitest";
import { LEGAL, legalPlaceholdersPending, PLACEHOLDER_PATTERN } from "./legal";

describe("the legal facts", () => {
  it("are filled in, so the pages are no longer drafts", () => {
    expect(LEGAL.ownerName).toBe("Sviatlana Buben");
    expect(LEGAL.nif).toBe("330791745");
    expect(LEGAL.address).toBe("Lagarto 5, 2705-044 Almoçageme, Portugal");
    expect(LEGAL.adrEntity.name).toMatch(/^CNIACC/);
    expect(LEGAL.email).toBe("edit@issebya.com");
    for (const value of Object.values(LEGAL)) {
      if (typeof value === "string") expect(PLACEHOLDER_PATTERN.test(value)).toBe(false);
    }
    expect(legalPlaceholdersPending()).toBe(false);
  });

  it("recognise a placeholder", () => {
    expect(PLACEHOLDER_PATTERN.test("[[NIF]]")).toBe(true);
    expect(PLACEHOLDER_PATTERN.test("330791745")).toBe(false);
  });

  it("use https links for the complaints book, the consumer portal, the CNPD and the ADR entity", () => {
    for (const url of [
      LEGAL.complaintsBook,
      LEGAL.consumerPortal,
      LEGAL.dataProtectionAuthority.url,
      LEGAL.adrEntity.url,
    ]) {
      expect(url).toMatch(/^https:\/\//);
    }
  });
});
