import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { insideFolder } from "./policy.ts";
import {
  HEALTH_PATH,
  MAX_BODY_BYTES,
  RUN_PATH,
  TOKEN_HEADER,
  type RunRequest,
  encodeFrame,
  isRunRequest,
} from "./protocol.ts";

export interface BridgeOptions {
  // Names the bridge in health answers and log lines.
  name: string;
  // The one program this bridge runs, fixed when it starts.
  binary: string;
  // The shared token every run must carry.
  token: string;
  // Every run's folder must be inside this one (absolute, normal, existing).
  scratchDir: string;
  // "caller": the folder the shim sent (checked to be inside the scratch folder).
  // "scratch": always the scratch folder itself, whatever the caller's folder is
  // (the cut-out's arguments are already checked to be inside it).
  cwd?: "caller" | "scratch";
  // A reason to refuse these arguments, or null to run them.
  checkArgs: (argv: string[]) => string | null;
  // The program's environment; default the bridge's own, minus the token.
  childEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

// A program that ignores SIGTERM when its caller goes away is killed after this.
const KILL_AFTER_MS = 5000;

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

// The request body as text, or null when it is larger than MAX_BODY_BYTES.
async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Why this folder cannot be a run's folder, or null when it can. Both sides
// are compared by their real paths (a symlinked scratch folder, or the shim's
// process.cwd() after symlinks, must not refuse a folder inside it).
function cwdRefusal(cwd: string, scratchReal: string): string | null {
  let real: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's folder, checked below
    real = realpathSync(cwd);
  } catch {
    return "the folder does not exist";
  }
  if (!insideFolder(real, scratchReal)) return "the folder is not inside the scratch folder";
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked to be inside the scratch folder
  return statSync(real).isDirectory() ? null : "the folder is not a folder";
}

// Runs the request's argv under the bridge's one program, streaming its output
// as frames. A caller that disconnects before the exit gets its program
// stopped (SIGTERM, then SIGKILL), so a cancelled step leaves nothing running.
function runProgram(res: ServerResponse, request: RunRequest, options: BridgeOptions): void {
  const started = performance.now();
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const env = { ...(options.childEnv ?? process.env) };
  delete env.BRIDGE_TOKEN;
  const child = spawn(options.binary, request.argv, {
    cwd: request.cwd,
    env,
    stdio: [request.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let finished = false;
  let killer: NodeJS.Timeout | undefined;

  if (request.stdin !== null && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin);
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    res.write(encodeFrame({ out: "stdout", data: chunk.toString("base64") }));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    res.write(encodeFrame({ out: "stderr", data: chunk.toString("base64") }));
  });
  child.on("error", (error) => {
    if (finished) return;
    finished = true;
    res.write(encodeFrame({ error: `${options.name}: cannot run the program: ${error.message}` }));
    res.end();
  });
  child.on("close", (code, signal) => {
    finished = true;
    clearTimeout(killer);
    res.write(encodeFrame({ exit: { code, signal } }));
    res.end();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    options.log?.(`${options.name}: exit ${signal ?? code} after ${seconds} s`);
  });
  res.on("close", () => {
    if (finished) return;
    child.kill("SIGTERM");
    killer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
    killer.unref();
  });
}

interface Resolved extends BridgeOptions {
  scratchReal: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, options: Resolved) {
  if (req.method === "GET" && req.url === HEALTH_PATH) {
    send(res, 200, { ok: true, name: options.name });
    return;
  }
  if (req.method !== "POST" || req.url !== RUN_PATH) {
    send(res, 404, { error: "not found" });
    return;
  }
  if (!tokenMatches(req.headers[TOKEN_HEADER], options.token)) {
    send(res, 401, { error: "the token is missing or wrong" });
    return;
  }
  const body = await readBody(req);
  if (body === null) {
    send(res, 413, { error: "the request is too large" });
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    send(res, 400, { error: "the body is not JSON" });
    return;
  }
  if (!isRunRequest(value)) {
    send(res, 400, { error: "the body is not a run request" });
    return;
  }
  const folderRefusal =
    options.cwd === "scratch" ? null : cwdRefusal(value.cwd, options.scratchReal);
  const refusal = folderRefusal ?? options.checkArgs(value.argv);
  if (refusal) {
    send(res, 400, { error: refusal });
    return;
  }
  const folder = options.cwd === "scratch" ? options.scratchReal : value.cwd;
  runProgram(res, { ...value, cwd: folder }, options);
}

// The HTTP server of one bridge (not yet listening). Health needs no token;
// every run does.
export function createBridge(options: BridgeOptions): Server {
  const log = options.log ?? ((line: string) => console.log(line));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's scratch folder, once
  const withLog: Resolved = { ...options, log, scratchReal: realpathSync(options.scratchDir) };
  return createServer((req, res) => {
    handle(req, res, withLog).catch((error: unknown) => {
      log(`${options.name}: request failed: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) send(res, 500, { error: "the bridge failed" });
      else res.end();
    });
  });
}
