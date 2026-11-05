import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOB_STEPS, RULE_WORDS, refusalReason, stepWords } from "./step-words";

// The worker's one list of step names, read as text (the studio never
// imports the worker): one double-quoted name per line inside STEP_NAMES.
const STEP_NAMES_FILE = new URL("../../../worker/src/step-names.ts", import.meta.url);

function workerStepNames(): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed worker file
  const text = readFileSync(STEP_NAMES_FILE, "utf8");
  const list = text.slice(text.indexOf("STEP_NAMES"), text.indexOf("] as const"));
  return [...list.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

describe("stepWords", () => {
  it("gives every worker step words of its own", () => {
    const names = workerStepNames();
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(stepWords(name).doing, name).not.toBe("Working on it");
      expect(stepWords(name).failed, name).not.toBe("Could not finish this step");
    }
  });

  it("falls back to Working on it for an unknown step", () => {
    expect(stepWords("teleport")).toEqual({
      doing: "Working on it",
      failed: "Could not finish this step",
    });
    expect(stepWords("toString").doing).toBe("Working on it");
  });

  it("says plain words for the steps the overlay shows", () => {
    expect(stepWords("convert").doing).toBe("Preparing your video");
    expect(stepWords("transcribe").failed).toBe("Could not finish listening to your words");
    expect(stepWords("decide")).toEqual({
      doing: "Styling your reel",
      failed: "Could not finish styling",
    });
  });

  it("fills the restore's version number", () => {
    expect(stepWords("restore", { restoreNumber: 3 }).doing).toBe("Going back to version 3");
    expect(stepWords("restore").doing).toBe("Going back to an earlier version");
  });
});

describe("JOB_STEPS", () => {
  it("lists only worker step names", () => {
    const names = new Set(workerStepNames());
    for (const list of Object.values(JOB_STEPS)) {
      for (const name of list) expect(names.has(name), name).toBe(true);
    }
    expect(JOB_STEPS.process).toHaveLength(8);
    expect(JOB_STEPS.start_over).toEqual(["decide"]);
  });
});

describe("refusalReason", () => {
  it("maps every rule to words", () => {
    for (const rule of Object.keys(RULE_WORDS)) expect(refusalReason([rule])).not.toBeNull();
  });

  it("joins the first two distinct words, capitalised", () => {
    expect(refusalReason(["behind-caption", "safe-box", "frame"])).toBe(
      "A photo would cover your captions and something would sit outside the safe area",
    );
    expect(refusalReason(["answer-json", "answer-schema"])).toBe(
      "The AI's answer could not be used",
    );
  });

  it("gives null for unknown or missing rules", () => {
    expect(refusalReason(["mystery"])).toBeNull();
    expect(refusalReason([])).toBeNull();
    expect(refusalReason(null)).toBeNull();
  });
});
