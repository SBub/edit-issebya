import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "";
}

// At start-up, before the first heartbeat or claim (both read the scratch
// volume): creates the scratch folder with its parents. When it cannot, one
// line naming the path and the reason, then exit 1.
export async function prepareScratchDir(
  dir: string,
  {
    error = console.error,
    exit = process.exit,
  }: { error?: (message: string) => void; exit?: (code: number) => void } = {},
): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's scratch folder
    await mkdir(dir, { recursive: true });
  } catch (reason) {
    error(`worker: scratch folder ${dir} cannot be created: ${firstLine(reason)}`);
    exit(1);
  }
}

async function assertWritableFolder(dir: string, message: string): Promise<void> {
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new Error(message);
  }
}

// For the doctor: whether the scratch folder exists or could be created,
// creating nothing. Throws a message naming the path when neither holds.
export async function scratchDirState(dir: string): Promise<"exists" | "can be created"> {
  let info;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's scratch folder
    info = await stat(dir);
  } catch (error) {
    if (!isMissing(error)) throw new Error(`${dir}: ${firstLine(error)}`);
    info = null;
  }
  if (info) {
    if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
    await assertWritableFolder(dir, `${dir} is not writable`);
    return "exists";
  }
  let ancestor = dirname(dir);
  for (;;) {
    let found;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- an ancestor of the worker's scratch folder
      found = await stat(ancestor);
    } catch (error) {
      if (!isMissing(error)) {
        throw new Error(`${dir} cannot be created: ${ancestor}: ${firstLine(error)}`);
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`${dir} cannot be created: no existing ancestor`);
      ancestor = parent;
      continue;
    }
    const message = `${dir} cannot be created: ${ancestor} is not a writable folder`;
    if (!found.isDirectory()) throw new Error(message);
    await assertWritableFolder(ancestor, message);
    return "can be created";
  }
}
