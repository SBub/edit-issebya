import { describe, expect, it, vi } from "vitest";
import { runJobKind } from "./job-kinds.ts";

function runners() {
  return {
    process: vi.fn(async () => {}),
    change: vi.fn<(request: string) => Promise<void>>(async () => {}),
    restore: vi.fn<(versionId: string) => Promise<void>>(async () => {}),
    render: vi.fn<(versionId: string) => Promise<void>>(async () => {}),
  };
}

const NONE = { request: null, restore_version_id: null, version_id: null };

function expectOnly(r: ReturnType<typeof runners>, kind: keyof ReturnType<typeof runners> | null) {
  for (const [name, fn] of Object.entries(r)) {
    if (name !== kind) expect(fn).not.toHaveBeenCalled();
  }
}

describe("runJobKind", () => {
  it("runs the whole pipeline for a process job", async () => {
    const r = runners();
    await runJobKind({ kind: "process", ...NONE }, r);
    expect(r.process).toHaveBeenCalledOnce();
    expectOnly(r, "process");
  });

  it("runs only decide, with the request, for a change job", async () => {
    const r = runners();
    await runJobKind({ kind: "change", ...NONE, request: "no accent on 'work'" }, r);
    expect(r.change).toHaveBeenCalledExactlyOnceWith("no accent on 'work'");
    expectOnly(r, "change");
  });

  it("runs only restore, with the version, for a restore job", async () => {
    const r = runners();
    await runJobKind({ kind: "restore", ...NONE, restore_version_id: "v1" }, r);
    expect(r.restore).toHaveBeenCalledExactlyOnceWith("v1");
    expectOnly(r, "restore");
  });

  it("runs only render, with its version, for a render job", async () => {
    const r = runners();
    await runJobKind({ kind: "render", ...NONE, version_id: "v3" }, r);
    expect(r.render).toHaveBeenCalledExactlyOnceWith("v3");
    expectOnly(r, "render");
  });

  it("fails a change without a request, a restore or render without a version and an unknown kind", () => {
    const r = runners();
    expect(() => runJobKind({ kind: "change", ...NONE }, r)).toThrow(/no request/);
    expect(() => runJobKind({ kind: "restore", ...NONE }, r)).toThrow(/no version/);
    expect(() => runJobKind({ kind: "render", ...NONE }, r)).toThrow(
      /render job has no version to export/,
    );
    expect(() => runJobKind({ kind: "publish", ...NONE }, r)).toThrow(/unknown job kind: publish/);
    expectOnly(r, null);
  });
});
