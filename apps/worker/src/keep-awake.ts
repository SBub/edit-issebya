import { spawn as nodeSpawn } from "node:child_process";

// What keep-awake needs of a spawned child; tests pass a fake.
type Spawn = (
  file: string,
  args: string[],
  options: { stdio: "ignore" },
) => {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
};

const CAFFEINATE = "/usr/bin/caffeinate";

// Keeps a Mac from idle-sleeping for as long as this process lives: starts
// `caffeinate -i -w <pid>` (it also ends by itself if the process dies) and
// returns the function that stops it. Nothing is spawned on any other platform,
// and a missing caffeinate never fails anything. Used by the worker's jobs
// (withKeepAwake) and by the native bridges (apps/worker/src/bridge).
export function startKeepAwake({
  platform = process.platform,
  pid = process.pid,
  spawn = nodeSpawn,
}: { platform?: NodeJS.Platform; pid?: number; spawn?: Spawn } = {}): () => void {
  if (platform !== "darwin") return () => {};
  const child = spawn(CAFFEINATE, ["-i", "-w", String(pid)], { stdio: "ignore" });
  child.on("error", () => {});
  return () => child.kill("SIGTERM");
}

// Keeps a Mac from idle-sleeping while a job runs: `caffeinate -i -w <pid>`
// (it also ends by itself if the worker dies), killed when the work ends,
// whatever the outcome. Nothing is spawned on any other platform, and a
// missing caffeinate never fails the job.
export async function withKeepAwake<T>(
  work: () => Promise<T>,
  options: { platform?: NodeJS.Platform; pid?: number; spawn?: Spawn } = {},
): Promise<T> {
  const stop = startKeepAwake(options);
  try {
    return await work();
  } finally {
    stop();
  }
}
