// The wire format between a shim (inside the worker container) and a bridge
// (native, on the Mac). One POST runs the bridge's one program with the shim's
// argv (and stdin, when the shim sends one) in the shim's folder, and streams
// its stdout and stderr back as NDJSON frames, then its exit.

// The request header carrying the shared token (BRIDGE_TOKEN).
export const TOKEN_HEADER = "x-bridge-token";
// Fixed ports on the Mac: the Claude Code bridge and the cut-out bridge.
export const CLAUDE_BRIDGE_PORT = 8791;
export const CUTOUT_BRIDGE_PORT = 8792;
// Bound to loopback unless the Docker Desktop check in app_docs/worker-container.md
// says otherwise; the token is required either way.
export const BRIDGE_HOST = "127.0.0.1";
export const RUN_PATH = "/run";
export const HEALTH_PATH = "/health";
// The largest request body a bridge reads (a prompt and its schema).
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface RunRequest {
  argv: string[];
  // Absolute, inside the scratch folder both sides mount at the same path.
  cwd: string;
  // The stdin text, or null when the shim sends none.
  stdin: string | null;
}

// One line of the response: a chunk of stdout or stderr (base64, so bytes stay
// exact), the exit of the program, or a refusal or failure before it ran.
export type Frame =
  | { out: "stdout" | "stderr"; data: string }
  | { exit: { code: number | null; signal: string | null } }
  | { error: string };

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

// Throws on a line that is not a frame: the shim treats the call as failed.
export function parseFrame(line: string): Frame {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") throw new Error("bridge frame is not an object");
  const frame = value as Record<string, unknown>;
  if (typeof frame.error === "string") return { error: frame.error };
  if (frame.exit && typeof frame.exit === "object") {
    const exit = frame.exit as Record<string, unknown>;
    const code = exit.code;
    const signal = exit.signal;
    if (
      (code === null || typeof code === "number") &&
      (signal === null || typeof signal === "string")
    ) {
      return { exit: { code, signal } };
    }
  }
  if ((frame.out === "stdout" || frame.out === "stderr") && typeof frame.data === "string") {
    return { out: frame.out, data: frame.data };
  }
  throw new Error("bridge frame has no known shape");
}

export function isRunRequest(value: unknown): value is RunRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    Array.isArray(request.argv) &&
    request.argv.every((arg) => typeof arg === "string") &&
    typeof request.cwd === "string" &&
    (request.stdin === null || typeof request.stdin === "string")
  );
}
