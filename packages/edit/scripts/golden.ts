// Writes the baseline fixture version and every fixture's golden page and
// widths from the Node build: `yarn workspace @edit-issebya/edit golden`.
// Commit what it writes; the Node and browser tests compare against it.
import { writeFile } from "node:fs/promises";
import { baselineEdit } from "../src/baseline.ts";
import { ISSEBYA_PRESET } from "../src/preset.ts";
import { goldenOf } from "../src/test-support/golden.ts";
import { SHORT_SPEECH, baselineInputs } from "../src/test-support/inputs.ts";
import { nodeMeasurer } from "../src/test-support/measurer.node.ts";

const testdata = new URL("../src/testdata/", import.meta.url);

const baseline = baselineEdit(SHORT_SPEECH.transcript, baselineInputs(), ISSEBYA_PRESET);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
await writeFile(
  new URL("versions/baseline-short-speech.edit.json", testdata),
  `${JSON.stringify(baseline, null, 2)}\n`,
);

// Re-imported after the baseline is written, so the goldens build the new one.
const { FIXTURES } = await import("../src/test-support/fixtures.ts");
for (const fixture of FIXTURES) {
  const { html, widths } = goldenOf(fixture, await nodeMeasurer());
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await writeFile(new URL(`golden/${fixture.name}.html`, testdata), html);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await writeFile(new URL(`golden/${fixture.name}.widths.json`, testdata), widths);
  console.log(`${fixture.name}: ${html.length} bytes`);
}
