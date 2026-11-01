import { describe, expect, it, vi } from "vitest";
import { runJobKind } from "./job-kinds.ts";

function runners() {
  return {
    process: vi.fn(async () => {}),
    change: vi.fn<(request: string) => Promise<void>>(async () => {}),
    restore: vi.fn<(versionId: string) => Promise<void>>(async () => {}),
  };
}

const NONE = { request: null, restore_version_id: null };

describe("runJobKind", () => {
  it("runs the whole pipeline for a process job", async () => {
    const r = runners();
    await runJobKind({ kind: "process", ...NONE }, r);
    expect(r.process).toHaveBeenCalledOnce();
    expect(r.change).not.toHaveBeenCalled();
    expect(r.restore).not.toHaveBeenCalled();
  });

  it("runs only decide, with the request, for a change job", async () => {
    const r = runners();
    await runJobKind(
      { kind: "change", request: "no accent on 'work'", restore_version_id: null },
      r,
    );
    expect(r.change).toHaveBeenCalledExactlyOnceWith("no accent on 'work'");
    expect(r.process).not.toHaveBeenCalled();
    expect(r.restore).not.toHaveBeenCalled();
  });

  it("runs only restore, with the version, for a restore job", async () => {
    const r = runners();
    await runJobKind({ kind: "restore", request: null, restore_version_id: "v1" }, r);
    expect(r.restore).toHaveBeenCalledExactlyOnceWith("v1");
    expect(r.process).not.toHaveBeenCalled();
    expect(r.change).not.toHaveBeenCalled();
  });

  it("fails a change without a request, a restore without a version and an unknown kind", () => {
    const r = runners();
    expect(() => runJobKind({ kind: "change", ...NONE }, r)).toThrow(/no request/);
    expect(() => runJobKind({ kind: "restore", ...NONE }, r)).toThrow(/no version/);
    expect(() => runJobKind({ kind: "render", ...NONE }, r)).toThrow(/unknown job kind: render/);
    expect(r.process).not.toHaveBeenCalled();
    expect(r.change).not.toHaveBeenCalled();
    expect(r.restore).not.toHaveBeenCalled();
  });
});
