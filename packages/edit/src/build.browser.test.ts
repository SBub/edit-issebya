import { describe, expect, it } from "vitest";
import { FIXTURES } from "./test-support/fixtures.ts";
import { goldenOf } from "./test-support/golden.ts";
import { GOLDENS } from "./test-support/goldens.ts";
import { browserMeasurer } from "./test-support/measurer.browser.ts";

// The studio's environment: the same builder in Chromium must give the very
// page and widths the Node build committed.
describe("build in the browser", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} equals its golden byte for byte`, async () => {
      const built = goldenOf(fixture, await browserMeasurer());
      expect(built.widths).toBe(GOLDENS[fixture.name]!.widths);
      expect(built.html).toBe(GOLDENS[fixture.name]!.html);
    });
  }
});
