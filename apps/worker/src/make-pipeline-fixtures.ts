// `yarn workspace @edit-issebya/worker fixtures:pipeline`: runs the real
// pipeline on each committed clip against a temporary folder fake (no
// database, no R2) and writes every step's outputs and their fingerprints,
// which the E2E specs seed so every step is a hit. The short-speech clip's
// outputs sit at fixtures/pipeline/ itself; every other clip's sit in a folder
// named after it (fixtures/pipeline/speech-ten/). Each folder has its own
// manifest.json. Re-run after any step version or setting change
// (pipeline-fixtures.test.ts fails until then).
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStorage } from "@edit-issebya/storage";
import { PIPELINE, fingerprintsFor, outputFiles } from "./pipeline/definition.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";

const REPOSITORY = new URL("../../../", import.meta.url).pathname;
const SOURCE_KEY = `reels/${TEST_JOB.reel_id}/source/original.mp4`;

// Each committed clip and the folder (under fixtures/pipeline/) its outputs go
// to. The short-speech clip's folder is the top one, as it always was.
const CLIPS = [
  { name: "short-speech", folder: "" },
  { name: "speech-ten", folder: "speech-ten/" },
];

async function makeOutputs({ name, folder }: { name: string; folder: string }) {
  const CLIP = join(REPOSITORY, `fixtures/footage/${name}.mp4`);
  const OUT = join(REPOSITORY, "fixtures/pipeline", folder);
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
    const manifest = {
      source,
      steps: [] as { name: string; fingerprint: string; files: string[] }[],
    };
    for (const step of PIPELINE) {
      const fingerprint = fingerprints[step.name]!;
      // Only this clip's step folders go; a sibling clip's folder stays.
      await rm(join(OUT, step.name), { recursive: true, force: true });
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
    for (const call of calls) if (call.call === "done") console.log(`${name}: ${call.summary}`);
    console.log(`wrote ${OUT}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

for (const clip of CLIPS) await makeOutputs(clip);
