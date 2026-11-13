import { describe, expect, it, vi } from "vitest";
import { checkPromptSource, draftId, isInside, readDraftPrompt } from "./draft-prompt.ts";

const REPO = "/work/repo";

describe("isInside", () => {
  it("is true for the repository and what is in it, false for anything outside", () => {
    expect(isInside(REPO, REPO)).toBe(true);
    expect(isInside(REPO, "/work/repo/apps/worker/judge.txt")).toBe(true);
    expect(isInside(REPO, "/work/repo/../elsewhere/judge.txt")).toBe(false);
    // A sibling whose name only starts the same way is not inside.
    expect(isInside(REPO, "/work/repo-other/judge.txt")).toBe(false);
    expect(isInside(REPO, "/home/owner/judge.txt")).toBe(false);
  });
});

describe("the draft id", () => {
  it("is `draft:` and the first 12 hex digits of the text's sha256, stable for the same text", () => {
    expect(draftId("abc")).toBe("draft:ba7816bf8f01");
    expect(draftId("abc")).toBe(draftId("abc"));
    expect(draftId("abd")).not.toBe(draftId("abc"));
  });
});

describe("readDraftPrompt", () => {
  it("refuses a file inside the repository before it is read", async () => {
    const read = vi.fn(async () => "judge");
    await expect(
      readDraftPrompt({ path: "/work/repo/apps/worker/judge.txt", repoRoot: REPO, read }),
    ).rejects.toThrow(/inside the repository/);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a file outside it, recording its name and its draft id", async () => {
    const text = "judge {{script}} {{picks}}";
    const read = async (path: string) => {
      expect(path).toBe("/home/owner/judge-v9.txt");
      return text;
    };
    expect(
      await readDraftPrompt({ path: "/home/owner/judge-v9.txt", repoRoot: REPO, read }),
    ).toEqual({ text, file: "judge-v9.txt", id: draftId(text) });
  });

  it("refuses an empty file", async () => {
    const read = async () => "  \n";
    await expect(
      readDraftPrompt({ path: "/home/owner/judge.txt", repoRoot: REPO, read }),
    ).rejects.toThrow(/is empty/);
  });
});

describe("the prompt source", () => {
  it("takes a PostHog label or a draft file, never both", () => {
    expect(() => checkPromptSource({})).not.toThrow();
    expect(() => checkPromptSource({ label: "staging" })).not.toThrow();
    expect(() => checkPromptSource({ promptFile: "/home/owner/judge.txt" })).not.toThrow();
    expect(() =>
      checkPromptSource({ label: "staging", promptFile: "/home/owner/judge.txt" }),
    ).toThrow(/mutually exclusive/);
  });
});
