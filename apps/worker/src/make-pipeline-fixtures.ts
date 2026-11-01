// `yarn workspace @edit-issebya/worker fixtures:pipeline`: runs the real
// pipeline on the committed clip against a temporary folder fake (no
// database, no R2) and writes every step's outputs and their fingerprints to
// fixtures/pipeline/, which the E2E upload spec seeds so every step is a hit.
// Re-run after any step version or setting change (pipeline-fixtures.test.ts
// fails until then).
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, fakeStorage } from "@edit-issebya/storage";
import { PIPELINE, fingerprintsFor, outputFiles } from "./pipeline/definition.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";

const REPOSITORY = new URL("../../../", import.meta.url).pathname;
const CLIP = join(REPOSITORY, "fixtures/footage/short-speech.mp4");
const OUT = join(REPOSITORY, "fixtures/pipeline");
const SOURCE_KEY = `reels/${TEST_JOB.reel_id}/source/original.mp4`;

const work = await mkdtemp(join(tmpdir(), "pipeline-fixtures-"));
try {
  const root = join(work, "store");
  const scratch = join(work, "scratch");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fresh temp folder
  await mkdir(scratch);
  const storage = fakeStorage({ root, uploadUrlBase: "" });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed clip
  await storage.put(SOURCE_KEY, new Uint8Array(await readFile(CLIP)));
  const { steps, calls } = recordingSteps(SOURCE_KEY);
  await runPipeline({
    ctx: stepContext(steps),
    storage,
    keyPrefix: "",
    scratchDir: scratch,
    tools: toolPaths(),
  });

  const head = await storage.head(SOURCE_KEY);
  const source = { etag: head!.etag!, bytes: head!.bytes };
  const fingerprints = fingerprintsFor(source);
  await rm(OUT, { recursive: true, force: true });
  const manifest = {
    source,
    steps: [] as { name: string; fingerprint: string; files: string[] }[],
  };
  for (const step of PIPELINE) {
    const fingerprint = fingerprints[step.name]!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- under fixtures/pipeline
    await mkdir(join(OUT, step.name), { recursive: true });
    for (const file of outputFiles(step)) {
      await copyFile(
        join(root, cacheKey("", step.name, fingerprint, file)),
        join(OUT, step.name, file),
      );
    }
    manifest.steps.push({ name: step.name, fingerprint, files: outputFiles(step) });
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- under fixtures/pipeline
  await writeFile(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const call of calls) if (call.call === "done") console.log(call.summary);
  console.log(`wrote ${OUT}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
