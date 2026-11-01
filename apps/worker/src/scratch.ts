import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { formatBytes } from "./format.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sizeOf(path: string): Promise<number> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch directory
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch directory
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

// Runs one job in `<root>/<jobId>` and removes that directory when the job
// ends, on success, failure or a lost lease, logging the bytes freed. Later
// steps' frame caches and intermediate encodes live inside it.
export async function runInScratch<T>(
  { root, jobId, log }: { root: string; jobId: string; log: (line: string) => void },
  work: (dir: string) => Promise<T>,
): Promise<T> {
  if (!UUID.test(jobId)) throw new Error(`invalid job id for scratch: ${JSON.stringify(jobId)}`);
  const dir = join(root, jobId);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- root plus a checked UUID
  await mkdir(dir, { recursive: true });
  try {
    return await work(dir);
  } finally {
    const bytes = await sizeOf(dir).catch(() => 0);
    await rm(dir, { recursive: true, force: true });
    log(`job ${jobId}: scratch cleared, ${formatBytes(bytes)} freed`);
  }
}
