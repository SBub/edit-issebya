import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EngineNote } from "@edit-issebya/edit";
import { buildTrace, formatScript, formatTrace } from "./decision-trace.ts";

// THE DECISION TRACE FREEZE (app_docs/component-template.md, step 0): the
// answer that uses every component, with the engine record that packages/edit
// froze for it (`component-freeze.test.ts`), through the trace and the
// script, byte for byte. Words and ids only; no prompt wording.

const edit = (name: string) => new URL(`../../../packages/edit/src/${name}`, import.meta.url);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own committed test data
const read = (name: string) => JSON.parse(readFileSync(edit(name), "utf8")) as unknown;

describe("decision trace freeze", () => {
  it("traces the every-component answer the same way", async () => {
    const answer = read("testdata/freeze/every-input.json") as Parameters<typeof buildTrace>[0];
    const record = read("testdata/freeze/every-record.json") as EngineNote[];
    const { words } = read("testdata/rethink-work/transcript.json") as {
      words: { id: string; text: string; start: number; end: number }[];
    };
    const trace = buildTrace(answer, record, words);
    const out = {
      trace,
      text: formatTrace("every component", trace),
      script: formatScript("every component", answer, words),
    };
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      "./testdata/decision-trace-freeze.json",
    );
  });
});
