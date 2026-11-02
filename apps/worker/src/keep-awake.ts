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

// Keeps a Mac from idle-sleeping while a job runs: `caffeinate -i -w <pid>`
// (it also ends by itself if the worker dies), killed when the work ends,
// whatever the outcome. Nothing is spawned on any other platform, and a
// missing caffeinate never fails the job.
export async function withKeepAwake<T>(
  work: () => Promise<T>,
  {
    platform = process.platform,
    pid = process.pid,
    spawn = nodeSpawn,
  }: { platform?: NodeJS.Platform; pid?: number; spawn?: Spawn } = {},
): Promise<T> {
  if (platform !== "darwin") return work();
  const child = spawn(CAFFEINATE, ["-i", "-w", String(pid)], { stdio: "ignore" });
  child.on("error", () => {});
  try {
    return await work();
  } finally {
    child.kill("SIGTERM");
  }
}
