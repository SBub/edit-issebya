import { type BridgeExit, BridgeRefused, callBridge } from "./client.ts";

type Env = Record<string, string | undefined>;

export interface ShimOptions {
  // Names the shim in its own error lines.
  name: string;
  // The environment variable holding this bridge's URL.
  urlVar: string;
  // Whether the caller's stdin is forwarded (claude takes its prompt there).
  readsStdin: boolean;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

// Waits until what was written to stdout and stderr has left the process.
function flushed(): Promise<void> {
  return Promise.all([
    new Promise<void>((done) => process.stdout.write("", () => done())),
    new Promise<void>((done) => process.stderr.write("", () => done())),
  ]).then(() => undefined);
}

function fail(name: string, message: string): void {
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
}

// The shim's whole job: forward argv, the folder and (when asked) stdin to the
// bridge, write its stdout and stderr where the shim's own go, and end with the
// same exit code, or the same signal, the program ended with. A signal sent to
// the shim is passed to the bridge (it stops the program) and then re-raised.
export async function runShim(
  options: ShimOptions,
  env: Env = process.env,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const url = env[options.urlVar]?.trim();
  const token = env.BRIDGE_TOKEN?.trim();
  if (!url) return fail(options.name, `${options.urlVar} is not set`);
  if (!token) return fail(options.name, "BRIDGE_TOKEN is not set");
  const stdin = options.readsStdin
    ? process.stdin.isTTY
      ? ""
      : await readAll(process.stdin)
    : null;

  const controller = new AbortController();
  let received: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    received = signal;
    controller.abort();
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  const reraise = async (signal: NodeJS.Signals) => {
    for (const s of SIGNALS) process.off(s, onSignal);
    await flushed();
    process.kill(process.pid, signal);
  };

  let exit: BridgeExit;
  try {
    exit = await callBridge({
      url,
      token,
      argv,
      cwd: process.cwd(),
      stdin,
      signal: controller.signal,
      onOutput: (stream, chunk) => {
        (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
      },
    });
  } catch (error) {
    for (const s of SIGNALS) process.off(s, onSignal);
    if (received) return reraise(received);
    const message = error instanceof Error ? error.message : String(error);
    return fail(options.name, error instanceof BridgeRefused ? message : message);
  }
  for (const s of SIGNALS) process.off(s, onSignal);
  if (exit.signal) {
    await flushed();
    process.kill(process.pid, exit.signal as NodeJS.Signals);
    return;
  }
  await flushed();
  process.exitCode = exit.code ?? 1;
}
