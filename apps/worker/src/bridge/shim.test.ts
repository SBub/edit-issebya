import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridge } from "./server.ts";

// The shim as the worker runs it: a real child process of node, here running
// the bridge's program node itself (argv `-e <code>`).
const SHIM = fileURLToPath(new URL("../../bin/claude-bridge.ts", import.meta.url));
const TOKEN = "shim-token-0123456789";
let scratch: string;
let job: string;
let server: Server | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "shim-scratch-"));
  job = join(scratch, "job");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
  await mkdir(job);
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((done) => (server ? server.close(() => done(undefined)) : done(undefined)));
  server = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function bridgeUrl(): Promise<string> {
  server = createBridge({
    name: "test-bridge",
    binary: process.execPath,
    token: TOKEN,
    scratchDir: scratch,
    checkArgs: () => null,
    log: () => {},
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function runShim(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      cwd: job,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

describe("the claude shim", () => {
  it("reproduces stdout, stderr and the exit code of the bridge's program", async () => {
    const url = await bridgeUrl();
    const result = await runShim(
      ["-e", "process.stdout.write('hello '); process.stderr.write('warn'); process.exit(4)"],
      { CLAUDE_BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN },
      "",
    );
    expect(result).toMatchObject({ code: 4, signal: null, stdout: "hello ", stderr: "warn" });
  });

  it("forwards stdin, so a prompt reaches the program", async () => {
    const url = await bridgeUrl();
    const result = await runShim(
      ["-e", "process.stdin.pipe(process.stdout)"],
      { CLAUDE_BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN },
      "the prompt",
    );
    expect(result.stdout).toBe("the prompt");
    expect(result.code).toBe(0);
  });

  it("reproduces the program's signal", async () => {
    const url = await bridgeUrl();
    const result = await runShim(
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { CLAUDE_BRIDGE_URL: url, BRIDGE_TOKEN: TOKEN },
      "",
    );
    expect(result.signal).toBe("SIGTERM");
  });

  it("fails with one line and exit 1 without its URL or token", async () => {
    const noUrl = await runShim(["-e", "0"], { BRIDGE_TOKEN: TOKEN }, "");
    expect(noUrl).toMatchObject({
      code: 1,
      stderr: "claude-bridge: CLAUDE_BRIDGE_URL is not set\n",
    });
    const noToken = await runShim(["-e", "0"], { CLAUDE_BRIDGE_URL: "http://127.0.0.1:9" }, "");
    expect(noToken).toMatchObject({ code: 1, stderr: "claude-bridge: BRIDGE_TOKEN is not set\n" });
  });

  it("fails with exit 1 when the bridge is unreachable", async () => {
    const result = await runShim(
      ["-e", "0"],
      { CLAUDE_BRIDGE_URL: "http://127.0.0.1:1", BRIDGE_TOKEN: TOKEN },
      "",
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/cannot reach the bridge/);
  });
});
