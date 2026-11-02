import { constants } from "node:os";

// What `/usr/bin/time` reports about the process it ran: the kernel's wait4
// accounting (RUSAGE_CHILDREN), so CPU summed over every reaped descendant and
// the max RSS of the largest single process. Never the whole machine.
export interface TimeReport {
  cpuMs: number;
  peakRssBytes: number;
}

// The report command for this platform: BSD `-l` on macOS, GNU `-v` on Linux.
export function timeCommand(platform: NodeJS.Platform): [string, string] {
  if (platform === "darwin") return ["/usr/bin/time", "-l"];
  if (platform === "linux") return ["/usr/bin/time", "-v"];
  throw new Error(`step runner: no per-process measurement on ${platform}`);
}

function cpuMs(userSeconds: number, sysSeconds: number): number {
  return Math.round((userSeconds + sysSeconds) * 1000);
}

// macOS: `0.01 real 0.00 user 0.00 sys` and `1998848  maximum resident set
// size` (bytes). Null when the report is missing.
export function parseBsdTimeReport(text: string): TimeReport | null {
  const times = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(text);
  const rss = /(\d+)\s+maximum resident set size/.exec(text);
  if (!times || !rss) return null;
  return {
    cpuMs: cpuMs(Number(times[2]), Number(times[3])),
    peakRssBytes: Number(rss[1]),
  };
}

// Linux (GNU time -v): `User time (seconds): x`, `System time (seconds): y`
// and `Maximum resident set size (kbytes): k`. The `Command exited with
// non-zero status N` and `Command terminated by signal N` lines are ignored.
export function parseGnuTimeReport(text: string): TimeReport | null {
  const user = /User time \(seconds\):\s*([\d.]+)/.exec(text);
  const sys = /System time \(seconds\):\s*([\d.]+)/.exec(text);
  const rss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
  if (!user || !sys || !rss) return null;
  return {
    cpuMs: cpuMs(Number(user[1]), Number(sys[1])),
    peakRssBytes: Number(rss[1]) * 1024,
  };
}

export function parseTimeReport(platform: NodeJS.Platform, text: string): TimeReport | null {
  return platform === "darwin" ? parseBsdTimeReport(text) : parseGnuTimeReport(text);
}

// The signal that killed the tool, as the report says it: `/usr/bin/time`
// outlives its tool, so the step sees time's own exit (GNU: 128 + N, macOS: 1)
// and only the report tells a kill from an exit. GNU names the number
// (`SIGKILL`); macOS says only `command terminated abnormally` (`signal`).
// Null when the tool exited on its own.
export function reportedSignal(platform: NodeJS.Platform, report: string): string | null {
  if (platform === "darwin") {
    return /command terminated abnormally/i.test(report) ? "signal" : null;
  }
  const match = /Command terminated by signal (\d+)/.exec(report);
  if (!match) return null;
  const number = Number(match[1]);
  const name = Object.entries(constants.signals).find(([, value]) => value === number)?.[0];
  return name ?? `signal ${number}`;
}
