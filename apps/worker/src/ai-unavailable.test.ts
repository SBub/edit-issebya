import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unavailableReason } from "./ai-unavailable.ts";

function resultText(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  const text = readFileSync(new URL(`./testdata/ai-unavailable/${name}`, import.meta.url), "utf8");
  return (JSON.parse(text) as { result: string }).result;
}

describe("unavailableReason", () => {
  it("maps each captured message to its reason", () => {
    expect(unavailableReason(resultText("usage-limit.json"))).toBe("usage limit reached");
    expect(unavailableReason(resultText("not-logged-in.json"))).toBe(
      "Claude Code is not logged in",
    );
    expect(unavailableReason(resultText("not-logged-in-exit.txt"))).toBe(
      "Claude Code is not logged in",
    );
  });

  it.each([
    ["Your limit will reset at 5pm", "usage limit reached"],
    ["5-hour limit reached", "usage limit reached"],
    ["OAuth token has expired", "Claude Code is not logged in"],
    ["NOT LOGGED IN", "Claude Code is not logged in"],
  ])("reads %s as %s", (text, reason) => {
    expect(unavailableReason(text)).toBe(reason);
  });

  it("says nothing of an unrelated message", () => {
    expect(unavailableReason("Error: max turns reached")).toBeNull();
    expect(unavailableReason("")).toBeNull();
  });
});
