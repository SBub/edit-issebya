import { describe, expect, it } from "vitest";
import {
  parseBsdTimeReport,
  parseGnuTimeReport,
  reportedSignal,
  timeCommand,
} from "./time-report.ts";

// Captured with `/usr/bin/time -l sh -c '...; exit 3'` on macOS 14.
const BSD_REPORT = `        1.27 real         0.84 user         0.31 sys
           211845120  maximum resident set size
                   0  average shared memory size
                   0  average unshared data size
                   0  average unshared stack size
                 350  page reclaims
                  36  page faults
                   0  swaps
                   0  block input operations
                   0  block output operations
                   0  messages sent
                   0  messages received
                   0  signals received
                   9  voluntary context switches
                 228  involuntary context switches
            27170299  instructions retired
            27476317  cycles elapsed
             1426304  peak memory footprint
`;

// GNU time 1.9 `-v`, as its man page prints it, for a command that exited 1.
const GNU_REPORT = `Command exited with non-zero status 1
\tCommand being timed: "node -e process.exit(1)"
\tUser time (seconds): 0.84
\tSystem time (seconds): 0.31
\tPercent of CPU this job got: 90%
\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:01.27
\tAverage shared text size (kbytes): 0
\tAverage unshared data size (kbytes): 0
\tAverage stack size (kbytes): 0
\tAverage total size (kbytes): 0
\tMaximum resident set size (kbytes): 206880
\tAverage resident set size (kbytes): 0
\tMajor (requiring I/O) page faults: 0
\tMinor (reclaiming a frame) page faults: 51234
\tVoluntary context switches: 12
\tInvoluntary context switches: 3
\tSwaps: 0
\tFile system inputs: 0
\tFile system outputs: 0
\tSocket messages sent: 0
\tSocket messages received: 0
\tSignals delivered: 0
\tPage size (bytes): 4096
\tExit status: 1
`;

describe("timeCommand", () => {
  it("picks the report flag per platform", () => {
    expect(timeCommand("darwin")).toEqual(["/usr/bin/time", "-l"]);
    expect(timeCommand("linux")).toEqual(["/usr/bin/time", "-v"]);
    expect(() => timeCommand("win32")).toThrow("step runner: no per-process measurement on win32");
  });
});

describe("parseBsdTimeReport", () => {
  it("reads CPU (user + sys) and max RSS in bytes", () => {
    expect(parseBsdTimeReport(BSD_REPORT)).toEqual({ cpuMs: 1150, peakRssBytes: 211_845_120 });
  });

  it("is null without a report", () => {
    expect(parseBsdTimeReport("")).toBeNull();
    expect(parseBsdTimeReport("time: tool: No such file or directory\n")).toBeNull();
  });
});

describe("parseGnuTimeReport", () => {
  it("reads CPU (user + sys) and max RSS in kilobytes, after a non-zero exit", () => {
    expect(parseGnuTimeReport(GNU_REPORT)).toEqual({
      cpuMs: 1150,
      peakRssBytes: 206_880 * 1024,
    });
  });

  it("reads a report after a signal", () => {
    const killed = GNU_REPORT.replace(
      "Command exited with non-zero status 1",
      "Command terminated by signal 9",
    );
    expect(parseGnuTimeReport(killed)?.cpuMs).toBe(1150);
  });

  it("is null without a report", () => {
    expect(parseGnuTimeReport("")).toBeNull();
    expect(parseGnuTimeReport(BSD_REPORT)).toBeNull();
  });
});

describe("reportedSignal", () => {
  it("names GNU time's signal", () => {
    expect(
      reportedSignal("linux", "\tCommand terminated by signal 9\n\tUser time (seconds): 0.01"),
    ).toBe("SIGKILL");
    expect(reportedSignal("linux", "\tCommand exited with non-zero status 1\n")).toBeNull();
  });

  it("says only `signal` for macOS time's abnormal end", () => {
    expect(reportedSignal("darwin", "time: command terminated abnormally\n 0.02 real")).toBe(
      "signal",
    );
    expect(reportedSignal("darwin", "        0.02 real         0.01 user")).toBeNull();
  });
});
