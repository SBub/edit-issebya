import { startKeepAwake } from "../keep-awake.ts";
import { BRIDGE_HOST } from "./protocol.ts";
import { createBridge } from "./server.ts";

type Env = Record<string, string | undefined>;

// Starts one native bridge from the environment (its file is loaded by the
// yarn script), keeps the Mac awake for as long as it lives, and stops it on
// SIGINT or SIGTERM. Throws, naming the variable, when one is missing.
export function serveBridge({
  name,
  port,
  binary,
  checkArgs,
  cwd = "caller",
  env = process.env,
  platform = process.platform,
}: {
  name: string;
  port: number;
  binary: string;
  cwd?: "caller" | "scratch";
  checkArgs: (argv: string[], scratchDir: string) => string | null;
  env?: Env;
  platform?: NodeJS.Platform;
}) {
  const token = env.BRIDGE_TOKEN?.trim();
  if (!token)
    throw new Error(`${name}: BRIDGE_TOKEN is not set (fill apps/worker/.env.development)`);
  const scratch = env.WORKER_SCRATCH_DIR?.trim();
  if (!scratch) {
    throw new Error(
      `${name}: WORKER_SCRATCH_DIR is not set; the container mounts that folder at the same path`,
    );
  }
  const scratchDir = scratch;
  const server = createBridge({
    name,
    binary,
    token,
    scratchDir,
    cwd,
    checkArgs: (argv) => checkArgs(argv, scratchDir),
  });
  // Native only: caffeinate keeps the Mac awake while this bridge runs (a
  // sleeping Mac freezes Docker and every job in it).
  const stopKeepAwake = startKeepAwake({ platform });
  server.listen(port, BRIDGE_HOST, () => {
    console.log(`${name}: listening on http://${BRIDGE_HOST}:${port}, running ${binary}`);
  });
  const stop = () => {
    stopKeepAwake();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

// Prints one line and exits 1: the entry points' way to refuse to start.
export function refuseToStart(message: string): never {
  console.error(message);
  process.exit(1);
}
