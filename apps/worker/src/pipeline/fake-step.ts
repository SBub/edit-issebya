// The pipeline step double's process (E2E_MOCK_STEPS=true only): copies each
// of a step's committed fixture outputs to `<dir>/<file>.part`, then renames it
// to `<file>`, the way the real steps write. A fault makes it fail on purpose:
// `signal` kills itself with SIGKILL (a tool killed by a signal), `exit`
// exits 1, `half` writes the first half of the first output to its `.part`
// name and then waits (at most 20 seconds) for the spec to kill the worker.
//
// Arguments: <none|signal|exit|half> <fixture dir> <output dir> <file>...
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.E2E_MOCK_STEPS !== "true") {
  console.error("fake-step: runs only under E2E_MOCK_STEPS=true");
  process.exit(2);
}
const [fault, fixtureDir, outputDir, ...files] = process.argv.slice(2);
if (!fault || !fixtureDir || !outputDir || files.length === 0) {
  console.error("usage: fake-step <none|signal|exit|half> <fixture dir> <output dir> <file>...");
  process.exit(2);
}

if (fault === "signal") {
  console.log("fake-step: killing itself");
  process.kill(process.pid, "SIGKILL");
}
if (fault === "exit") {
  console.error("fake-step: failed on purpose");
  process.exit(1);
}
if (fault === "half") {
  const first = files[0]!;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed fixture
  const bytes = await readFile(join(fixtureDir, first));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the step's folder
  await writeFile(
    join(outputDir, `${first}.part`),
    bytes.subarray(0, Math.floor(bytes.length / 2)),
  );
  console.error("fake-step: half written");
  await sleep(20_000);
  process.exit(1);
}

for (const file of files) {
  const partial = join(outputDir, `${file}.part`);
  await copyFile(join(fixtureDir, file), partial);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the step's folder
  await rename(partial, join(outputDir, file));
}
console.log(`fake-step: ${files.length} file(s) written`);
