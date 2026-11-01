import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { StepTailError, recordHit, runStep, runToolsStep } from "./step-runner.ts";
import { createTelemetry } from "./telemetry.ts";

// Real child processes under /usr/bin/time: Node itself is the tool.
const NODE = process.execPath;
const MB = 1024 * 1024;
const TIMEOUT = { timeout: 20_000 };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "step-runner-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function node(script: string, extra: Partial<Parameters<typeof runStep>[1]> = {}) {
  return { name: "probe", file: NODE, args: ["-e", script], describe: "probed", ...extra };
}

function onlyDone(calls: ReturnType<typeof recordingSteps>["calls"]) {
  const done = calls.find((c) => c.call === "done");
  if (!done || done.call !== "done") throw new Error(`no done call: ${JSON.stringify(calls)}`);
  return done;
}

describe("runStep", () => {
  it("measures CPU and peak memory of the tool, not the worker", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await runStep(
      stepContext(steps),
      node(
        "const b = Buffer.alloc(200 * 1024 * 1024, 1); const t = Date.now(); while (Date.now() - t < 1100) {} void b;",
      ),
    );
    const { measurements } = onlyDone(calls);
    expect(measurements.peak_rss_bytes).toBeGreaterThanOrEqual(200 * MB);
    expect(measurements.cpu_ms).toBeGreaterThanOrEqual(500);
    expect(measurements.wall_ms).toBeGreaterThanOrEqual(1000);
  });

  it("does not count waiting as CPU", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await runStep(stepContext(steps), node("setTimeout(() => {}, 1000)"));
    const { measurements } = onlyDone(calls);
    expect(measurements.wall_ms).toBeGreaterThanOrEqual(1000);
    expect(measurements.cpu_ms).toBeLessThan(200);
  });

  describe("a tool with three grandchildren holding 100 MB each for 4 seconds", () => {
    const hold = "const b = Buffer.alloc(100 * 1024 * 1024, 1); setTimeout(() => void b, 4000);";
    const parent = `
      const { spawn } = require("node:child_process");
      let left = 3;
      for (let i = 0; i < 3; i++) {
        spawn(process.execPath, ["-e", ${JSON.stringify(hold)}], { stdio: "ignore" })
          .on("exit", () => { left -= 1; });
      }
      const wait = setInterval(() => { if (left === 0) clearInterval(wait); }, 50);
    `;

    it("stores the whole tree's peak with group sampling", TIMEOUT, async () => {
      const { steps, calls } = recordingSteps();
      await runStep(stepContext(steps), node(parent, { sampleGroupMemory: true }));
      expect(onlyDone(calls).measurements.peak_rss_bytes).toBeGreaterThanOrEqual(300 * MB);
    });

    it("stores the largest single process without it", TIMEOUT, async () => {
      const { steps, calls } = recordingSteps();
      await runStep(stepContext(steps), node(parent));
      expect(onlyDone(calls).measurements.peak_rss_bytes).toBeLessThan(200 * MB);
    });
  });

  it("counts the bytes of declared inputs and outputs", TIMEOUT, async () => {
    const input = join(dir, "in.bin");
    const output = join(dir, "out.bin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's temp folder
    await writeFile(input, Buffer.alloc(123_456, 7));
    const { steps, calls } = recordingSteps();
    await runStep(stepContext(steps), {
      name: "copy",
      file: NODE,
      args: [
        "-e",
        `const fs = require("node:fs"); fs.readFileSync(process.argv[1]); fs.writeFileSync(process.argv[2], Buffer.alloc(654321, 1));`,
        input,
        output,
      ],
      inputs: [input],
      outputs: [output],
      describe: "copied",
    });
    const done = onlyDone(calls);
    expect(done.measurements.bytes_in).toBe(123_456);
    expect(done.measurements.bytes_out).toBe(654_321);
    expect(done.summary).toMatch(/^copied, (under a second|\d+ seconds?), 639\.0 KB$/);
  });

  it("stores the tail of a failed tool's output and throws", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    const script = `
      for (let i = 1; i <= 50; i++) process.stderr.write("line " + i + "\\n");
      setTimeout(() => {
        for (let i = 51; i <= 100; i++) process.stdout.write("line " + i + "\\n");
        process.exitCode = 1;
      }, 300);
    `;
    await expect(runStep(stepContext(steps), node(script))).rejects.toThrow(
      /probe exited with 1\n[^]*line 100$/,
    );
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    const lines = failed.tail.split("\n");
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 81}`));
    expect(lines).not.toContain("line 1");
    expect(failed.summary).toMatch(/^probe failed, /);
    expect(failed.measurements.cpu_ms).not.toBeNull();
    expect(calls.some((c) => c.call === "done")).toBe(false);
  });

  it("fails a tool that does not exist with null CPU and memory", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runStep(stepContext(steps), {
        name: "probe",
        file: join(dir, "no-such-tool"),
        args: [],
        describe: "probed",
      }),
    ).rejects.toThrow(/probe exited with 12[67]/);
    const failed = calls.find((c) => c.call === "failed");
    expect(failed).toMatchObject({
      call: "failed",
      measurements: { cpu_ms: null, peak_rss_bytes: null, bytes_in: null, bytes_out: null },
    });
  });

  it("kills the process group on abort and writes nothing more", TIMEOUT, async () => {
    const pidFile = join(dir, "pid");
    const { steps, calls } = recordingSteps();
    const controller = new AbortController();
    const running = runStep(
      stepContext(steps, { signal: controller.signal }),
      node(
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`,
      ),
    );
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's temp folder
      pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort(new Error("lease lost"));
    await expect(running).rejects.toThrow("lease lost");
    expect(calls.map((c) => c.call)).toEqual(["start"]);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("runToolsStep", () => {
  const busy = (mb: number, ms: number) =>
    `const b = Buffer.alloc(${mb} * 1024 * 1024, 1); const t = Date.now(); while (Date.now() - t < ${ms}) {} void b;`;

  it("sums CPU over the calls and keeps the larger peak", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    const stdouts: string[] = [];
    await runToolsStep(stepContext(steps), {
      name: "two",
      async work(tool) {
        stdouts.push(await tool({ file: NODE, args: ["-e", `${busy(50, 600)} console.log("a")`] }));
        stdouts.push(
          await tool({ file: NODE, args: ["-e", `${busy(200, 600)} console.log("b")`] }),
        );
        return { what: "both ran" };
      },
    });
    expect(stdouts).toEqual(["a\n", "b\n"]);
    const { measurements, summary } = onlyDone(calls);
    // Each call alone burns at least ~500 ms of CPU.
    expect(measurements.cpu_ms).toBeGreaterThanOrEqual(1000);
    expect(measurements.peak_rss_bytes).toBeGreaterThanOrEqual(200 * MB);
    expect(measurements.peak_rss_bytes).toBeLessThan(250 * MB);
    expect(measurements.wall_ms).toBeGreaterThanOrEqual(1200);
    expect(summary).toMatch(/^both ran, \d+ seconds?$/);
  });

  it("stores the measurements so far and the failing call's tail", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(stepContext(steps), {
        name: "two",
        async work(tool) {
          await tool({ file: NODE, args: ["-e", busy(10, 600)] });
          await tool({
            file: NODE,
            args: ["-e", `console.error("first"); console.error("second"); process.exit(3)`],
          });
          return { what: "never" };
        },
      }),
    ).rejects.toThrow(/two exited with 3\nfirst\nsecond$/);
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.tail).toBe("first\nsecond");
    expect(failed.measurements.cpu_ms).toBeGreaterThanOrEqual(500);
    expect(failed.measurements.wall_ms).toBeGreaterThanOrEqual(600);
    expect(failed.summary).toMatch(/^two failed, /);
  });

  it("keeps the measurements when the work fails between calls", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(stepContext(steps), {
        name: "parse",
        async work(tool) {
          await tool({ file: NODE, args: ["-e", busy(10, 600)] });
          throw new Error("unexpected answer");
        },
      }),
    ).rejects.toThrow("unexpected answer");
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.tail.split("\n")[0]).toBe("Error: unexpected answer");
    expect(failed.measurements.cpu_ms).toBeGreaterThanOrEqual(500);
  });

  it("writes input to the tool's stdin", TIMEOUT, async () => {
    const { steps } = recordingSteps();
    let echoed = "";
    await runToolsStep(stepContext(steps), {
      name: "echo",
      async work(tool) {
        echoed = await tool({ file: "/bin/cat", args: [], input: "line one\nline two" });
        return { what: "echoed" };
      },
    });
    expect(echoed).toBe("line one\nline two\n");
  });

  it("kills a call that runs past its timeout and fails the step", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    const started = Date.now();
    await expect(
      runToolsStep(stepContext(steps), {
        name: "slow",
        async work(tool) {
          await tool({ file: "/bin/sleep", args: ["30"], timeoutMs: 1000 });
          return { what: "never" };
        },
      }),
    ).rejects.toThrow(/^slow timed out after 1 s/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.tail).toBe("slow timed out after 1 s");
  });

  it("stores a StepTailError's own tail", async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(stepContext(steps), {
        name: "decide",
        async work() {
          throw new StepTailError("decide failed twice\nround 1: a\nround 2: b");
        },
      }),
    ).rejects.toThrow("decide failed twice");
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.tail).toBe("decide failed twice\nround 1: a\nround 2: b");
  });

  it("stores the summed AI usage on done", async () => {
    const { steps, calls } = recordingSteps();
    await runToolsStep(stepContext(steps), {
      name: "decide",
      async work(_tool, ai) {
        ai({ inputTokens: 1234, outputTokens: 567, costUsd: 0.0123, model: "claude-a" });
        ai({ inputTokens: 1, outputTokens: null, costUsd: 0.0001, model: "claude-b" });
        return { what: "decided" };
      },
    });
    expect(onlyDone(calls).ai).toEqual({
      inputTokens: 1235,
      outputTokens: 567,
      costUsd: 0.0124,
      model: "claude-b",
    });
  });

  it("stores the AI usage on failed, and none for a step without AI", async () => {
    const { steps, calls } = recordingSteps();
    const usage = { inputTokens: 10, outputTokens: 2, costUsd: 0.5, model: "claude-a" };
    await expect(
      runToolsStep(stepContext(steps), {
        name: "decide",
        async work(_tool, ai) {
          ai(usage);
          throw new Error("bad answer");
        },
      }),
    ).rejects.toThrow("bad answer");
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.ai).toEqual(usage);

    const plain = recordingSteps();
    await runToolsStep(stepContext(plain.steps), {
      name: "plain",
      work: async () => ({ what: "ran" }),
    });
    expect(onlyDone(plain.calls).ai).toBeUndefined();
  });
});

describe("recordHit", () => {
  it("writes one skipped call and a span with step.cache_hit", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { steps, calls } = recordingSteps();
    await recordHit(stepContext(steps, { telemetry }), {
      name: "convert",
      summary: "footage converted, reused",
      wallMs: 12,
    });
    expect(calls).toEqual([
      {
        call: "skipped",
        jobId: TEST_JOB.id,
        name: "convert",
        summary: "footage converted, reused",
        wallMs: 12,
      },
    ]);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["step convert"]);
    expect(spans[0]?.attributes).toMatchObject({
      "step.name": "convert",
      "step.cache_hit": true,
      "step.wall_ms": 12,
    });
  });

  it("writes nothing after an abort", async () => {
    const { steps, calls } = recordingSteps();
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));
    await expect(
      recordHit(stepContext(steps, { signal: controller.signal }), {
        name: "convert",
        summary: "x",
        wallMs: 0,
      }),
    ).rejects.toThrow("lease lost");
    expect(calls).toEqual([]);
  });
});
