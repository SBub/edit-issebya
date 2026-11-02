import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import {
  type ChildRun,
  type SpawnTool,
  type ToolCall,
  StepError,
  recordHit,
  runStep,
  runToolsStep,
} from "./step-runner.ts";
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

// Burns at least `ms` of CPU (user + sys) and lasts at least `ms` of wall time,
// holding `mb` MiB, then prints its own peak RSS in bytes as the last stdout line.
function spin(mb: number, ms: number): string {
  return `const b = Buffer.alloc(${mb} * 1024 * 1024, 1); const t = Date.now();
    for (;;) { const c = process.cpuUsage(); if (c.user + c.system >= ${ms} * 1000 && Date.now() - t >= ${ms}) break; }
    void b; console.log(process.resourceUsage().maxRSS * 1024);`;
}

function onlyDone(calls: ReturnType<typeof recordingSteps>["calls"]) {
  const done = calls.find((c) => c.call === "done");
  if (!done || done.call !== "done") throw new Error(`no done call: ${JSON.stringify(calls)}`);
  return done;
}

describe("runStep", () => {
  it("measures CPU and peak memory of the tool, not the worker", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await runStep(stepContext(steps), node(spin(200, 1100)));
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
    // Each grandchild prints its own peak RSS when it lets go; the parent writes
    // the largest of theirs and its own to `out`, the most `/usr/bin/time` can
    // report for one process. Group sampling reads the tree's current RSS, so the
    // buffer is random (macOS compresses a constant-filled one under memory
    // pressure, which once read 150 MB for 300 MB held) and every page is
    // touched again every 100 ms so none goes idle.
    const hold =
      'const b = require("node:crypto").randomFillSync(Buffer.allocUnsafe(100 * 1024 * 1024)); const k = setInterval(() => { for (let i = 0; i < b.length; i += 4096) b[i] ^= 1; }, 100); setTimeout(() => { clearInterval(k); console.log(process.resourceUsage().maxRSS * 1024); }, 4000);';
    const parent = (out: string) => `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const grandchildren = [];
      let left = 3;
      for (let i = 0; i < 3; i++) {
        let text = "";
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(hold)}], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        child.stdout.on("data", (chunk) => { text += chunk; });
        child.on("close", () => {
          grandchildren.push(Number(text.trim()));
          left -= 1;
          if (left === 0) {
            writeFileSync(${JSON.stringify(out)}, JSON.stringify(Math.max(...grandchildren, process.resourceUsage().maxRSS * 1024)));
          }
        });
      }
    `;

    it("stores the whole tree's peak with group sampling", TIMEOUT, async () => {
      const { steps, calls } = recordingSteps();
      const out = join(dir, "tree-sampled.json");
      await runStep(stepContext(steps), node(parent(out), { sampleGroupMemory: true }));
      expect(onlyDone(calls).measurements.peak_rss_bytes).toBeGreaterThanOrEqual(300 * MB);
    });

    it("stores the largest single process without it", TIMEOUT, async () => {
      const { steps, calls } = recordingSteps();
      const out = join(dir, "tree-single.json");
      await runStep(stepContext(steps), node(parent(out)));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's temp folder
      const largest = Number(JSON.parse(await readFile(out, "utf8")));
      const peak = onlyDone(calls).measurements.peak_rss_bytes ?? 0;
      expect(peak).toBeGreaterThanOrEqual(100 * MB);
      expect(peak).toBeGreaterThanOrEqual(largest);
      // See "keeps the larger peak": the report reads a little above the self-report.
      expect(peak - largest).toBeLessThan(16 * MB);
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
  it("sums CPU over the calls and keeps the larger peak", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    const stdouts: string[] = [];
    await runToolsStep(stepContext(steps), {
      name: "two",
      async work(tool) {
        stdouts.push(
          await tool({ file: NODE, args: ["-e", `console.log("a"); ${spin(50, 600)}`] }),
        );
        stdouts.push(
          await tool({ file: NODE, args: ["-e", `console.log("b"); ${spin(200, 600)}`] }),
        );
        return { what: "both ran" };
      },
    });
    const [selfA, selfB] = stdouts.map((stdout, i) => {
      const lines = stdout.split("\n").slice(0, -1);
      expect(lines[0]).toBe(["a", "b"][i]);
      return Number(lines.at(-1));
    }) as [number, number];
    const { measurements, summary } = onlyDone(calls);
    // Each call burns at least 600 ms of CPU by construction.
    expect(measurements.cpu_ms).toBeGreaterThanOrEqual(1000);
    const peak = measurements.peak_rss_bytes ?? 0;
    expect(peak).toBeGreaterThanOrEqual(200 * MB);
    expect(peak).toBeGreaterThanOrEqual(Math.max(selfA, selfB));
    // The report is taken at exit and reads 0 to 2.3 MiB above the child's own
    // maxRSS (macOS 0 to 1.7, Linux Docker 1.8 to 2.3). 16 MiB is about 7 times
    // that and well below the smaller call's own resident memory (at least
    // 46 MiB), so a sum cannot pass.
    expect(peak - Math.max(selfA, selfB)).toBeLessThan(16 * MB);
    expect(peak, "peak memory summed over the calls").toBeLessThan(selfA + selfB);
    expect(measurements.wall_ms).toBeGreaterThanOrEqual(1200);
    expect(summary).toMatch(/^both ran, \d+ seconds?$/);
  });

  it("stores the measurements so far and the failing call's tail", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(stepContext(steps), {
        name: "two",
        async work(tool) {
          await tool({ file: NODE, args: ["-e", spin(10, 600)] });
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
          await tool({ file: NODE, args: ["-e", spin(10, 600)] });
          throw new Error("unexpected answer");
        },
      }),
    ).rejects.toThrow("unexpected answer");
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.tail.split("\n")[0]).toBe("Error: unexpected answer");
    expect(failed.measurements.cpu_ms).toBeGreaterThanOrEqual(500);
  });
});

describe("runToolsStep stdin", () => {
  it("writes stdin to a real child and returns it as stdout", TIMEOUT, async () => {
    const { steps, calls } = recordingSteps();
    let echoed = "";
    await runToolsStep(stepContext(steps), {
      name: "echo",
      async work(tool) {
        echoed = await tool({ file: "/bin/cat", args: [], stdin: "the prompt\nsecond line" });
        return { what: "echoed" };
      },
    });
    expect(echoed).toBe("the prompt\nsecond line\n");
    expect(onlyDone(calls).summary).toMatch(/^echoed, /);
  });

  it("caps stdout at maxStdoutBytes when given", TIMEOUT, async () => {
    const { steps } = recordingSteps();
    let big = "";
    await runToolsStep(stepContext(steps), {
      name: "big",
      async work(tool) {
        big = await tool({
          file: NODE,
          args: ["-e", 'process.stdout.write("x".repeat(200 * 1024) + "\\n")'],
          maxStdoutBytes: 1024 * 1024,
        });
        return { what: "printed" };
      },
    });
    expect(big.length).toBe(200 * 1024 + 1);
  });
});

describe("runToolsStep AI usage and StepError", () => {
  const usage = { inputTokens: 1500, outputTokens: 456, costUsd: 0.0123, model: "claude-x" };
  const ok: ChildRun = {
    code: 0,
    exitSignal: null,
    report: "",
    output: "",
    stdout: "{}",
    groupPeakBytes: null,
  };

  it("passes stdin and maxStdoutBytes to the spawn", async () => {
    const seen: ToolCall[] = [];
    const spawnTool: SpawnTool = (call) => {
      seen.push(call);
      return Promise.resolve(ok);
    };
    const { steps } = recordingSteps();
    await runToolsStep(
      stepContext(steps),
      {
        name: "ai",
        async work(tool) {
          await tool({ file: "claude", args: ["-p"], stdin: "hello", maxStdoutBytes: 99 });
          return { what: "asked" };
        },
      },
      spawnTool,
    );
    expect(seen).toMatchObject([{ file: "claude", stdin: "hello", maxStdoutBytes: 99 }]);
  });

  it("writes the work's AI usage as the ai_* measurements", async () => {
    const { steps, calls } = recordingSteps();
    await runToolsStep(stepContext(steps), {
      name: "decide",
      async work() {
        return { what: "decided", ai: usage };
      },
    });
    expect(onlyDone(calls).measurements).toMatchObject({
      ai_input_tokens: 1500,
      ai_output_tokens: 456,
      ai_cost_usd: 0.0123,
      ai_model: "claude-x",
    });
  });

  it("puts a StepError's own tail and AI usage into the failed row", async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(stepContext(steps), {
        name: "decide",
        async work() {
          throw new StepError("decide failed twice", "round 1:\n- a\nround 2:\n- b", usage);
        },
      }),
    ).rejects.toThrow("decide failed twice");
    const failed = calls.find((c) => c.call === "failed");
    if (failed?.call !== "failed") throw new Error("no failed call");
    expect(failed.tail).toBe("round 1:\n- a\nround 2:\n- b");
    expect(failed.measurements).toMatchObject({ ai_input_tokens: 1500, ai_model: "claude-x" });
  });
});

describe("runToolsStep arithmetic", () => {
  // A `/usr/bin/time` report in this platform's format, with exact values.
  function timeReport(user: string, sys: string, bytes: number): string {
    return process.platform === "darwin"
      ? `        1.00 real         ${user} user         ${sys} sys\n${bytes}  maximum resident set size\n`
      : `\tUser time (seconds): ${user}\n\tSystem time (seconds): ${sys}\n\tMaximum resident set size (kbytes): ${bytes / 1024}\n`;
  }

  function run(code: number, report: string, groupPeakBytes: number): ChildRun {
    const output = code === 0 ? "ok\n" : "not found\n";
    return { code, exitSignal: null, report, output, stdout: output, groupPeakBytes };
  }

  function fakeSpawn(runs: ChildRun[]): SpawnTool {
    return () => {
      const next = runs.shift();
      if (!next) throw new Error("no more runs");
      return Promise.resolve(next);
    };
  }

  const a = run(0, timeReport("0.40", "0.12", 300 * MB), 200 * MB);
  const b = run(0, timeReport("1.00", "0.25", 100 * MB), 450 * MB);
  const neverStarted = () => run(127, timeReport("9.00", "0.99", 900 * MB), 999 * MB);

  it("sums CPU exactly and keeps the max of every report and group peak, skipping a tool that never started", async () => {
    const { steps, calls } = recordingSteps();
    await runToolsStep(
      stepContext(steps),
      {
        name: "two",
        async work(tool) {
          await tool({ file: "a", args: [] });
          await tool({ file: "b", args: [] });
          await expect(tool({ file: "c", args: [] })).rejects.toThrow(/two exited with 127/);
          return { what: "done" };
        },
      },
      fakeSpawn([a, b, neverStarted()]),
    );
    const { measurements } = onlyDone(calls);
    expect(measurements.cpu_ms).toBe(1770);
    // The sum of the peaks would be 600 MiB or more.
    expect(measurements.peak_rss_bytes).toBe(450 * MB);
  });

  it("a tool that never started leaves CPU and memory null", async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(
        stepContext(steps),
        {
          name: "one",
          async work(tool) {
            await tool({ file: "c", args: [] });
            return { what: "never" };
          },
        },
        fakeSpawn([neverStarted()]),
      ),
    ).rejects.toThrow(/exited with 127/);
    const failed = calls.find((c) => c.call === "failed");
    expect(failed).toMatchObject({
      call: "failed",
      measurements: { cpu_ms: null, peak_rss_bytes: null },
    });
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

describe("runToolsStep progress", () => {
  const parse = (line: string) => (line.startsWith("pct ") ? Number(line.slice(4)) : null);

  function loggingSpawn(lines: string[], code = 0): SpawnTool {
    return (_call, _signal, log) => {
      for (const line of lines) log(line, "stdout");
      const output = `${lines.join("\n")}\n`;
      return Promise.resolve({
        code,
        exitSignal: null,
        report: "",
        output,
        stdout: output,
        groupPeakBytes: null,
      });
    };
  }

  const lines = ["starting", "pct 5", "pct 20", "noise", "pct 60", "pct 90"];

  it("writes the throttled values, then 100 before done", async () => {
    const { steps, calls } = recordingSteps();
    await runToolsStep(
      stepContext(steps),
      {
        name: "long",
        async work(tool) {
          await tool({ file: "t", args: [], progress: parse });
          return { what: "made" };
        },
      },
      loggingSpawn(lines),
    );
    // Every line arrives inside the first 10 s window: the first value, then 100.
    expect(calls.map((c) => (c.call === "progress" ? `progress ${c.percent}` : c.call))).toEqual([
      "start",
      "progress 5",
      "progress 100",
      "done",
    ]);
    expect(calls.filter((c) => c.call === "progress").map((c) => c.stepId)).toEqual(["s1", "s1"]);
  });

  it("writes no progress for a call without a parser", async () => {
    const { steps, calls } = recordingSteps();
    await runToolsStep(
      stepContext(steps),
      {
        name: "short",
        async work(tool) {
          await tool({ file: "t", args: [] });
          return { what: "made" };
        },
      },
      loggingSpawn(lines),
    );
    expect(calls.some((c) => c.call === "progress")).toBe(false);
  });

  it("writes no 100 when the step fails", async () => {
    const { steps, calls } = recordingSteps();
    await expect(
      runToolsStep(
        stepContext(steps),
        {
          name: "long",
          async work(tool) {
            await tool({ file: "t", args: [], progress: parse });
            return { what: "made" };
          },
        },
        loggingSpawn(lines, 1),
      ),
    ).rejects.toThrow(/long exited with 1/);
    expect(calls.map((c) => (c.call === "progress" ? `progress ${c.percent}` : c.call))).toEqual([
      "start",
      "progress 5",
      "failed",
    ]);
  });
});
