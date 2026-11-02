// `yarn workspace @edit-issebya/worker fixtures:pipeline`: runs the real
// pipeline on the committed clip against a temporary folder fake (no
// database, no R2) and writes every step's outputs and their fingerprints to
// fixtures/pipeline/, which the E2E upload spec seeds so every step is a hit.
// Committed outputs whose fingerprint is still current are seeded first, so
// only new or changed steps run. Then the footage check runs on
// fixtures/footage-check/landscape.mp4 and its refused facts are written to
// fixtures/footage-check/ for the refusal spec. Re-run after any step version
// or setting change (pipeline-fixtures.test.ts fails until then).
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { causeOf, FootageRefusedError } from "./failures.ts";
import { FOOTAGE_FILE, checkFootage } from "./pipeline/check-footage.ts";
import { PIPELINE, fingerprintsFor, outputFiles } from "./pipeline/definition.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";

const REPOSITORY = new URL("../../../", import.meta.url).pathname;
const CLIP = join(REPOSITORY, "fixtures/footage/short-speech.mp4");
const OUT = join(REPOSITORY, "fixtures/pipeline");
const CHECK_OUT = join(REPOSITORY, "fixtures/footage-check");
const REFUSED_CLIPS = ["landscape.mp4"];
const SOURCE_KEY = `reels/${TEST_JOB.reel_id}/source/original.mp4`;

interface Manifest {
  source: { etag: string; bytes: number };
  steps: { name: string; fingerprint: string; files: string[] }[];
}

async function committedManifest(): Promise<Manifest | null> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- under fixtures/pipeline
    return JSON.parse(await readFile(join(OUT, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

// Every committed output whose fingerprint the definition still computes.
async function seedUnchanged(storage: Storage, source: Manifest["source"]): Promise<string[]> {
  const committed = await committedManifest();
  if (!committed || committed.source.etag !== source.etag) return [];
  const fingerprints = fingerprintsFor(source);
  const seeded: string[] = [];
  for (const step of committed.steps) {
    if (fingerprints[step.name] !== step.fingerprint) continue;
    for (const file of step.files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- under fixtures/pipeline
      const bytes = await readFile(join(OUT, step.name, file));
      await storage.put(cacheKey("", step.name, step.fingerprint, file), new Uint8Array(bytes));
    }
    seeded.push(step.name);
  }
  return seeded;
}

async function makePipelineFixtures(work: string): Promise<void> {
  const root = join(work, "store");
  const scratch = join(work, "scratch");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fresh temp folder
  await mkdir(scratch);
  const storage = fakeStorage({ root, uploadUrlBase: "" });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed clip
  await storage.put(SOURCE_KEY, new Uint8Array(await readFile(CLIP)));
  const head = await storage.head(SOURCE_KEY);
  const source = { etag: head!.etag!, bytes: head!.bytes };
  const seeded = await seedUnchanged(storage, source);
  if (seeded.length > 0) console.log(`seeded unchanged: ${seeded.join(", ")}`);

  const { steps, calls } = recordingSteps(SOURCE_KEY);
  await runPipeline({
    ctx: stepContext(steps),
    storage,
    keyPrefix: "",
    scratchDir: scratch,
    tools: toolPaths(),
  });

  const fingerprints = fingerprintsFor(source);
  await rm(OUT, { recursive: true, force: true });
  const manifest: Manifest = { source, steps: [] };
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
}

// The footage check alone on each refused clip: its facts and its message.
async function makeFootageCheckFixtures(work: string): Promise<void> {
  const clips = [];
  for (const file of REFUSED_CLIPS) {
    const name = file.replace(/\.mp4$/, "");
    const root = join(work, `check-${name}`);
    const scratch = join(root, "scratch");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fresh temp folder
    await mkdir(scratch, { recursive: true });
    const storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed clip
    await storage.put(SOURCE_KEY, new Uint8Array(await readFile(join(CHECK_OUT, file))));
    const head = await storage.head(SOURCE_KEY);
    const source = { etag: head!.etag!, bytes: head!.bytes };
    const error = await runPipeline({
      ctx: stepContext(recordingSteps(SOURCE_KEY).steps),
      storage,
      keyPrefix: "",
      scratchDir: scratch,
      tools: toolPaths(),
      pipeline: [checkFootage],
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const refused = causeOf(error, FootageRefusedError);
    if (!refused) throw new Error(`${file} was not refused: ${String(error)}`);
    const fingerprint = fingerprintsFor(source, [checkFootage]).check_footage!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- under fixtures/footage-check
    await mkdir(join(CHECK_OUT, name), { recursive: true });
    await copyFile(
      join(root, "store", cacheKey("", checkFootage.name, fingerprint, FOOTAGE_FILE)),
      join(CHECK_OUT, name, FOOTAGE_FILE),
    );
    clips.push({ file, source, fingerprint, files: [FOOTAGE_FILE], refusal: refused.message });
    console.log(`${file}: ${refused.message}`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- under fixtures/footage-check
  await writeFile(join(CHECK_OUT, "manifest.json"), `${JSON.stringify({ clips }, null, 2)}\n`);
  console.log(`wrote ${CHECK_OUT}`);
}

const work = await mkdtemp(join(tmpdir(), "pipeline-fixtures-"));
try {
  await makePipelineFixtures(work);
  await makeFootageCheckFixtures(work);
} finally {
  await rm(work, { recursive: true, force: true });
}
