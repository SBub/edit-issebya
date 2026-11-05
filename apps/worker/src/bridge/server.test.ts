import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeRefused, callBridge, checkBridgeHealth } from "./client.ts";
import { createBridge } from "./server.ts";
import { TOKEN_HEADER } from "./protocol.ts";

const TOKEN = "test-token-0123456789";
let scratch: string;
let job: string;
let servers: Server[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "bridge-scratch-"));
  job = join(scratch, "job");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
  await mkdir(job);
});

afterEach(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((s) => new Promise((done) => s.close(() => done(undefined)))));
  servers = [];
  await rm(scratch, { recursive: true, force: true });
});

// A bridge whose one program is node itself, so argv is node's: `-e <code>`.
async function startBridge(checkArgs: (argv: string[]) => string | null = () => null) {
  const server = createBridge({
    name: "test-bridge",
    binary: process.execPath,
    token: TOKEN,
    scratchDir: scratch,
    checkArgs,
    log: () => {},
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function collect() {
  const out = { stdout: "", stderr: "" };
  const onOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
    out[stream] += chunk.toString("utf8");
  };
  return { out, onOutput };
}

describe("the bridge server", () => {
  it("answers health without a token and names itself", async () => {
    const url = await startBridge();
    expect(await checkBridgeHealth(url)).toBe("test-bridge");
  });

  it("refuses a run without the token, with a wrong one, and any other path", async () => {
    const url = await startBridge();
    const body = JSON.stringify({ argv: ["-e", "0"], cwd: job, stdin: null });
    const post = (headers: Record<string, string>, path = "/run") =>
      fetch(new URL(path, url), { method: "POST", body, headers });
    expect((await post({})).status).toBe(401);
    expect((await post({ [TOKEN_HEADER]: "wrong" })).status).toBe(401);
    expect((await post({ [TOKEN_HEADER]: TOKEN }, "/nope")).status).toBe(404);
  });

  it("streams stdout, stderr and the exit code of its one program", async () => {
    const url = await startBridge();
    const { out, onOutput } = collect();
    const exit = await callBridge({
      url,
      token: TOKEN,
      argv: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      cwd: job,
      stdin: null,
      onOutput,
    });
    expect(exit).toEqual({ code: 3, signal: null });
    expect(out).toEqual({ stdout: "out", stderr: "err" });
  });

  it("passes stdin to the program", async () => {
    const url = await startBridge();
    const { out, onOutput } = collect();
    await callBridge({
      url,
      token: TOKEN,
      argv: ["-e", "process.stdin.pipe(process.stdout)"],
      cwd: job,
      stdin: "a prompt, ünïcode included",
      onOutput,
    });
    expect(out.stdout).toBe("a prompt, ünïcode included");
  });

  it("runs in the folder it is given, inside the scratch folder only", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    await writeFile(join(job, "marker.txt"), "here");
    const url = await startBridge();
    const { out, onOutput } = collect();
    await callBridge({
      url,
      token: TOKEN,
      argv: ["-e", "process.stdout.write(require('fs').readFileSync('marker.txt','utf8'))"],
      cwd: job,
      stdin: null,
      onOutput,
    });
    expect(out.stdout).toBe("here");
    await expect(
      callBridge({ url, token: TOKEN, argv: ["-e", "0"], cwd: tmpdir(), stdin: null, onOutput }),
    ).rejects.toThrow(/not inside the scratch folder/);
    await expect(
      callBridge({
        url,
        token: TOKEN,
        argv: ["-e", "0"],
        cwd: join(scratch, "missing"),
        stdin: null,
        onOutput,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("runs in the scratch folder whatever folder the caller sent, when told to", async () => {
    const server = createBridge({
      name: "test-bridge",
      binary: process.execPath,
      token: TOKEN,
      scratchDir: scratch,
      cwd: "scratch",
      checkArgs: () => null,
      log: () => {},
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { out, onOutput } = collect();
    await callBridge({
      url,
      token: TOKEN,
      argv: ["-e", "process.stdout.write(process.cwd())"],
      cwd: tmpdir(),
      stdin: null,
      onOutput,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    expect(out.stdout).toBe(realpathSync(scratch));
  });

  it("refuses arguments its check does not allow, before running anything", async () => {
    const url = await startBridge(() => "not allowed here");
    const { out, onOutput } = collect();
    await expect(
      callBridge({
        url,
        token: TOKEN,
        argv: ["-e", "process.stdout.write('ran')"],
        cwd: job,
        stdin: null,
        onOutput,
      }),
    ).rejects.toBeInstanceOf(BridgeRefused);
    expect(out.stdout).toBe("");
  });

  it("reports a program it cannot start as a failure, not a crash", async () => {
    const server = createBridge({
      name: "test-bridge",
      binary: join(scratch, "no-such-program"),
      token: TOKEN,
      scratchDir: scratch,
      checkArgs: () => null,
      log: () => {},
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await expect(
      callBridge({ url, token: TOKEN, argv: [], cwd: job, stdin: null, onOutput: () => {} }),
    ).rejects.toThrow(/cannot run the program/);
  });

  it("stops the program when the caller goes away before its exit", async () => {
    const pidFile = join(job, "pid");
    const url = await startBridge();
    const controller = new AbortController();
    const started = callBridge({
      url,
      token: TOKEN,
      argv: [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000)`,
      ],
      cwd: job,
      stdin: null,
      signal: controller.signal,
      onOutput: () => {},
    });
    const pid = await waitForFile(pidFile);
    controller.abort();
    await expect(started).rejects.toThrow();
    await waitUntilGone(Number(pid));
  });
});

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const { readFile } = await import("node:fs/promises");
      return await readFile(path, "utf8");
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  throw new Error(`${path} never appeared`);
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`process ${pid} is still running after the caller left`);
}
