import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
}

// `ps -A -o pid=,ppid=,rss=`: one `pid ppid rss` row per process.
export function parsePsTable(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const [pid, ppid, rssKb] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || rssKb === undefined) continue;
    if ([pid, ppid, rssKb].some((n) => !Number.isInteger(n))) continue;
    rows.push({ pid, ppid, rssKb });
  }
  return rows;
}

// RSS of the root and every descendant, in bytes (ps reports kilobytes on
// macOS and Linux). A pid is visited once, so a cycle cannot loop.
export function treeRssBytes(rows: readonly PsRow[], rootPid: number): number {
  const children = new Map<number, PsRow[]>();
  const byPid = new Map<number, PsRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const seen = new Set<number>();
  const queue = [rootPid];
  let kb = 0;
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    kb += byPid.get(pid)?.rssKb ?? 0;
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  return kb * 1024;
}

// One sample of the whole tree's memory under rootPid.
export async function sampleTreeRss(rootPid: number): Promise<number> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss="]);
  return treeRssBytes(parsePsTable(stdout), rootPid);
}
