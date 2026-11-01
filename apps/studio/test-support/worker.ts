import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalUrl } from "./local-supabase.ts";

const REPOSITORY_ROOT = new URL("../../../", import.meta.url).pathname;

// Ids of jobs a worker could claim now: queued, or running with an expired
// lease. claim_job takes the oldest one globally, so a test asserts this is
// empty first and never claims someone else's job on the shared stack.
export async function claimableJobIds(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin
    .from("jobs")
    .select("id")
    .or(`status.eq.queued,and(status.eq.running,lease_expires_at.lt.${new Date().toISOString()})`);
  if (error) throw new Error(`jobs not checked: ${error.message}`);
  return (data ?? []).map((row: { id: string }) => row.id);
}

// Spawns the worker's `once` against the local stack with the storage, AI and
// render doubles on, OTLP export off and the disk guard seeing 1000 GB free
// against a 10 GB minimum (so no spec depends on the runner's real disk; a
// spec overrides both), and resolves with its exit code and
// output. No spec ever starts a real render: only the tools spec passes
// `E2E_MOCK_RENDER: ""` (with a longer timeout).
export function runWorkerOnce(
  env: Record<string, string> = {},
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string }> {
  const childEnv = {
    ...process.env,
    // Empty variables in the environment win over apps/worker/.env.development,
    // so a filled file can never make a spec export to PostHog.
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
    SUPABASE_URL: assertLocalUrl(process.env.SUPABASE_URL),
    E2E_MOCK_STORAGE: "true",
    E2E_MOCK_AI: "true",
    E2E_MOCK_RENDER: "true",
    E2E_MOCK_FREE_DISK_GB: "1000",
    WORKER_MIN_FREE_DISK_GB: "10",
    WORKER_ID: `e2e-${crypto.randomUUID()}`,
    ...env,
  };
  assertLocalUrl(childEnv.SUPABASE_URL);
  return new Promise((resolve, reject) => {
    const child = spawn("yarn", ["workspace", "@edit-issebya/worker", "once"], {
      cwd: REPOSITORY_ROOT,
      env: childEnv,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`worker once timed out after ${timeoutMs} ms:\n${output}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
