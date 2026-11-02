import { describe, expect, it } from "vitest";
import {
  AiUnavailableError,
  FootageRefusedError,
  classifyFailure,
  dbFailure,
  toolExitOf,
} from "./failures.ts";
import { StepError } from "./step-runner.ts";

function withCode(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

function named(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name, ...extra });
}

function toolExit(code: number | null, signal: string | null): Error {
  return Object.assign(new Error("tool failed"), { exit: { code, signal, stdout: "" } });
}

function wrapped(cause: unknown, levels: number): Error {
  let error: unknown = cause;
  for (let level = 0; level < levels; level++)
    error = new Error(`level ${level}`, { cause: error });
  return error as Error;
}

describe("classifyFailure", () => {
  const cases: [string, unknown, ReturnType<typeof classifyFailure>][] = [
    ["a footage refusal", new FootageRefusedError("This clip has no sound."), "refused"],
    ["an unavailable AI", new AiUnavailableError("usage limit reached"), "ai_unavailable"],
    ["a decide refusal", new StepError("failed twice", "failed twice"), "permanent"],
    ["a schema failure", named("ZodError"), "permanent"],
    ["a tool's non-zero exit", toolExit(1, null), "permanent"],
    ["a tool killed by a signal", toolExit(null, "SIGKILL"), "transient"],
    ["ECONNRESET", withCode("ECONNRESET"), "transient"],
    ["ECONNREFUSED", withCode("ECONNREFUSED"), "transient"],
    ["ETIMEDOUT", withCode("ETIMEDOUT"), "transient"],
    ["EPIPE", withCode("EPIPE"), "transient"],
    ["EAI_AGAIN", withCode("EAI_AGAIN"), "transient"],
    ["an undici socket error", withCode("UND_ERR_SOCKET"), "transient"],
    ["an undici connect timeout", withCode("UND_ERR_CONNECT_TIMEOUT"), "transient"],
    ["an undici headers timeout", withCode("UND_ERR_HEADERS_TIMEOUT"), "transient"],
    ["an undici body timeout", withCode("UND_ERR_BODY_TIMEOUT"), "transient"],
    ["fetch failed", new TypeError("fetch failed"), "transient"],
    ["a TimeoutError", named("TimeoutError"), "transient"],
    ["an R2 RequestTimeout", named("RequestTimeout"), "transient"],
    ["an R2 InternalError", named("InternalError"), "transient"],
    ["an R2 SlowDown", named("SlowDown"), "transient"],
    [
      "an AWS-shaped 503",
      named("ServiceUnavailable", { $metadata: { httpStatusCode: 503 } }),
      "transient",
    ],
    ["an AWS-shaped 500", named("Unknown", { $metadata: { httpStatusCode: 500 } }), "transient"],
    ["an AWS-shaped 404", named("NoSuchKey", { $metadata: { httpStatusCode: 404 } }), "permanent"],
    [
      "a Supabase 503",
      dbFailure("step not finished", { error: { message: "unavailable" }, status: 503 }),
      "transient",
    ],
    [
      "a Supabase call that never got an answer",
      dbFailure("step not finished", { error: { message: "TypeError: fetch failed" }, status: 0 }),
      "transient",
    ],
    [
      "a Supabase 400",
      dbFailure("step not finished", { error: { message: "violates check" }, status: 400 }),
      "permanent",
    ],
    [
      "a 503 two levels deep",
      wrapped(named("ServiceUnavailable", { $metadata: { httpStatusCode: 503 } }), 2),
      "transient",
    ],
    ["a refusal wrapped in a step failure", wrapped(new FootageRefusedError("no"), 1), "refused"],
    ["an unknown error", new Error("something odd"), "permanent"],
    ["a thrown string", "boom", "permanent"],
  ];

  it.each(cases)("%s is %s", (_name, error, kind) => {
    expect(classifyFailure(error)).toBe(kind);
  });

  it("stops walking a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(classifyFailure(a)).toBe("permanent");
  });
});

describe("toolExitOf", () => {
  it("finds the exit through the cause chain", () => {
    expect(toolExitOf(wrapped(toolExit(2, null), 2))).toEqual({
      code: 2,
      signal: null,
      stdout: "",
    });
    expect(toolExitOf(new Error("no tool"))).toBeNull();
  });
});

describe("dbFailure", () => {
  it("names what failed and keeps the status", () => {
    const failure = dbFailure("reel not updated", { error: { message: "boom" }, status: 502 });
    expect(failure.message).toBe("reel not updated: boom");
    expect(failure.status).toBe(502);
    expect(dbFailure("x", { error: null }).status).toBe(0);
  });
});
