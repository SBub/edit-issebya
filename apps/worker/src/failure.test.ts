import { describe, expect, it } from "vitest";
import {
  AiUnavailable,
  FootageRefused,
  PermanentError,
  TransientError,
  findCause,
  isTransient,
  supabaseFailure,
} from "./failure.ts";
import { StepError } from "./step-runner.ts";

function withCode(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

function wrapped(cause: unknown, depth = 1): Error {
  let error: unknown = cause;
  for (let i = 0; i < depth; i += 1) error = new Error("outer", { cause: error });
  return error as Error;
}

describe("isTransient", () => {
  it.each([
    ["an explicit TransientError", new TransientError("blip")],
    ["a tool killed by a signal", Object.assign(new Error("killed"), { exitSignal: "SIGKILL" })],
    ["ECONNRESET", withCode("ECONNRESET")],
    ["ECONNREFUSED", withCode("ECONNREFUSED")],
    ["ETIMEDOUT", withCode("ETIMEDOUT")],
    ["EPIPE", withCode("EPIPE")],
    ["EAI_AGAIN", withCode("EAI_AGAIN")],
    ["ENOTFOUND", withCode("ENOTFOUND")],
    ["ENETUNREACH", withCode("ENETUNREACH")],
    ["EHOSTUNREACH", withCode("EHOSTUNREACH")],
    ["an undici error", withCode("UND_ERR_SOCKET")],
    ["fetch failed", new TypeError("fetch failed")],
    [
      "an AWS 503",
      Object.assign(new Error("Service Unavailable"), { $metadata: { httpStatusCode: 503 } }),
    ],
    ["an AWS server fault", Object.assign(new Error("InternalError"), { $fault: "server" })],
    ["an AWS TimeoutError", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["RequestTimeout", Object.assign(new Error("timed out"), { name: "RequestTimeout" })],
    [
      "RequestTimeoutException",
      Object.assign(new Error("timed out"), { name: "RequestTimeoutException" }),
    ],
    ["a Supabase 502", { message: "bad gateway", status: 502 }],
  ])("%s is transient", (_name, error) => {
    expect(isTransient(error)).toBe(true);
  });

  it.each([
    ["a PermanentError", new PermanentError("no")],
    ["a refusal", new FootageRefused("This clip has no sound.")],
    ["an unavailable AI", new AiUnavailable("the usage limit is reached")],
    ["a StepError", new StepError("checks failed", "reasons")],
    ["a tool exit 1", new Error("convert exited with 1\nInvalid data")],
    ["an AWS 404", Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } })],
    ["a client fault", Object.assign(new Error("bad"), { $fault: "client" })],
    ["a Supabase 400", { message: "bad request", status: 400 }],
    ["an unknown code", withCode("ENOENT")],
    ["a TypeError of another kind", new TypeError("x is not a function")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
  ])("%s is not transient", (_name, error) => {
    expect(isTransient(error)).toBe(false);
  });

  it("walks the cause chain", () => {
    expect(isTransient(wrapped(withCode("ECONNRESET"), 3))).toBe(true);
    expect(isTransient(wrapped(new TransientError("blip")))).toBe(true);
  });

  it("lets the outermost decisive link win", () => {
    const inner = Object.assign(new Error("503"), { $metadata: { httpStatusCode: 503 } });
    expect(isTransient(new PermanentError("after the AI call", { cause: inner }))).toBe(false);
    expect(isTransient(new TransientError("retry", { cause: new PermanentError("no") }))).toBe(
      true,
    );
  });

  it("stops after ten links", () => {
    expect(isTransient(wrapped(new TransientError("deep"), 9))).toBe(true);
    expect(isTransient(wrapped(new TransientError("too deep"), 10))).toBe(false);
  });
});

describe("findCause", () => {
  it("finds the first error of a class in the chain", () => {
    const refusal = new FootageRefused("This file is not a video.");
    expect(findCause(wrapped(refusal, 2), FootageRefused)).toBe(refusal);
    expect(findCause(wrapped(refusal, 2), AiUnavailable)).toBeNull();
    expect(findCause("text", FootageRefused)).toBeNull();
  });
});

describe("supabaseFailure", () => {
  it("is transient for a 5xx and for a network failure (status 0)", () => {
    for (const status of [503, 0]) {
      const error = supabaseFailure("version not read", { error: { message: "boom" }, status });
      expect(error).toBeInstanceOf(TransientError);
      expect(error.message).toBe("version not read: boom");
      expect(isTransient(error)).toBe(true);
    }
  });

  it("is a plain error for a 4xx", () => {
    const error = supabaseFailure("version not saved", {
      error: { message: "violates check" },
      status: 400,
    });
    expect(error).not.toBeInstanceOf(TransientError);
    expect(error.message).toBe("version not saved: violates check");
    expect(isTransient(error)).toBe(false);
  });
});
