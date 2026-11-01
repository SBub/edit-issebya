import { tmpdir } from "node:os";
import { keyPrefix } from "@edit-issebya/storage";

type Env = Record<string, string | undefined>;

export interface WorkerConfig {
  supabaseUrl: string;
  secretKey: string;
  workerId: string;
  pollIntervalSeconds: number;
  leaseSeconds: number;
  renewEveryMs: number;
  minFreeDiskGb: number;
  scratchDir: string;
  // R2_KEY_PREFIX: the folder of this mode's objects (`dev/`), or empty.
  keyPrefix: string;
}

function positiveNumber(env: Env, name: string, fallback: number, integer: boolean): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}, got ${raw}`);
  }
  return value;
}

// Read when the worker starts, never at module load, so typecheck and import
// need no variables. One message names every missing variable.
export function workerConfig(env: Env = process.env): WorkerConfig {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  const workerId = env.WORKER_ID?.trim();
  const missing = [
    ["SUPABASE_URL", supabaseUrl],
    ["SUPABASE_SECRET_KEY", secretKey],
    ["WORKER_ID", workerId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !supabaseUrl || !secretKey || !workerId) {
    throw new Error(`worker: missing ${missing.join(", ")} (fill apps/worker/.env.development)`);
  }
  const prefix = keyPrefix(env);
  if (prefix === null) {
    throw new Error(
      `R2_KEY_PREFIX must be empty or lower-case segments each ending with "/", got ${env.R2_KEY_PREFIX}`,
    );
  }
  return {
    supabaseUrl,
    secretKey,
    workerId,
    pollIntervalSeconds: positiveNumber(env, "WORKER_POLL_INTERVAL_SECONDS", 120, true),
    leaseSeconds: 300,
    renewEveryMs: 60_000,
    minFreeDiskGb: positiveNumber(env, "WORKER_MIN_FREE_DISK_GB", 10, false),
    scratchDir: env.WORKER_SCRATCH_DIR?.trim() || tmpdir(),
    keyPrefix: prefix,
  };
}
