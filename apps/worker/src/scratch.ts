import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { formatBytes } from "./format.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

// The size of every file under the folder (symlinks counted as themselves,
// never followed); 0 when it does not exist.
export async function directoryBytes(dir: string): Promise<number> {
  let info;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the worker's scratch folder
    info = await lstat(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (!info.isDirectory()) return info.size;
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the worker's scratch folder
    entries = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) total += await directoryBytes(join(dir, entry));
  return total;
}

// Runs one job in its own folder, `<scratchDir>/<job id>`, and removes the
// folder afterwards whatever happened (success, failure, a lost lease),
// logging the bytes it freed.
export async function withJobScratch<T>(
  scratchDir: string,
  jobId: string,
  run: (dir: string) => Promise<T>,
  log: (message: string) => void = console.log,
): Promise<T> {
  if (!UUID.test(jobId)) throw new Error(`scratch: job id is not a UUID: ${jobId}`);
  const dir = join(scratchDir, jobId);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job's own folder, the id checked above
  await mkdir(dir, { recursive: true });
  try {
    return await run(dir);
  } finally {
    const bytes = await directoryBytes(dir).catch(() => 0);
    await rm(dir, { recursive: true, force: true });
    log(`job ${jobId}: scratch removed, ${formatBytes(bytes)} freed`);
  }
}

// At start-up: removes the job folders (UUID names) a crashed worker left in
// the scratch folder. Everything else there stays.
export async function sweepStaleScratch(
  scratchDir: string,
  log: (message: string) => void = console.log,
): Promise<void> {
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's scratch folder
    entries = await readdir(scratchDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const dir = join(scratchDir, entry.name);
    const bytes = await directoryBytes(dir).catch(() => 0);
    await rm(dir, { recursive: true, force: true });
    log(`worker: stale scratch of job ${entry.name} removed, ${formatBytes(bytes)} freed`);
  }
}
