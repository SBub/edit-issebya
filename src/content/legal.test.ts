import { describe, expect, it } from "vitest";
import { CONFIRM, LEGAL, legalPlaceholdersPending, PLACEHOLDER_PATTERN } from "./legal";

describe("the legal facts", () => {
  it("mark every unknown provider fact as a placeholder", () => {
    expect(LEGAL.ownerName).toBe("[[OWNER_NAME]]");
    expect(LEGAL.nif).toBe("[[NIF]]");
    expect(LEGAL.address).toBe("[[ADDRESS]]");
    expect(LEGAL.adrEntity.placeholder).toBe("[[ADR_ENTITY]]");
    expect(PLACEHOLDER_PATTERN.test(CONFIRM)).toBe(true);
    expect(LEGAL.email).toBe("edit@issebya.com");
    expect(LEGAL.lastUpdated).toBe("2026-10-19");
  });

  it("keep the pages marked as a draft while any placeholder is left", () => {
    expect(legalPlaceholdersPending()).toBe(true);
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
