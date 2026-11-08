import { describe, expect, it, vi } from "vitest";
import { runJobKind } from "./job-kinds.ts";

function runners() {
  return {
    process: vi.fn(async () => {}),
    restore: vi.fn<(versionId: string) => Promise<void>>(async () => {}),
    render: vi.fn<(versionId: string) => Promise<void>>(async () => {}),
    describe_photo: vi.fn<(photoId: string) => Promise<void>>(async () => {}),
    start_over: vi.fn(async () => {}),
  };
}

const NONE = { restore_version_id: null, version_id: null, photo_id: null };

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

  it("fails a change job with a clear message and runs nothing", () => {
    const r = runners();
    expect(() => runJobKind({ kind: "change", ...NONE }, r)).toThrow(
      /change jobs are no longer run: the change box is removed/,
    );
    expectOnly(r, null);
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

  it("describes only the photo for a describe_photo job", async () => {
    const r = runners();
    await runJobKind({ kind: "describe_photo", ...NONE, photo_id: "p1" }, r);
    expect(r.describe_photo).toHaveBeenCalledExactlyOnceWith("p1");
    expectOnly(r, "describe_photo");
  });

  it("runs only the start over for a start_over job", async () => {
    const r = runners();
    await runJobKind({ kind: "start_over", ...NONE }, r);
    expect(r.start_over).toHaveBeenCalledOnce();
    expectOnly(r, "start_over");
  });

  it("fails a describe_photo job without a photo", () => {
    const r = runners();
    expect(() => runJobKind({ kind: "describe_photo", ...NONE }, r)).toThrow(
      /describe_photo job has no photo/,
    );
    expectOnly(r, null);
  });

  it("fails a restore or render without a version and an unknown kind", () => {
    const r = runners();
    expect(() => runJobKind({ kind: "restore", ...NONE }, r)).toThrow(/no version/);
    expect(() => runJobKind({ kind: "render", ...NONE }, r)).toThrow(
      /render job has no version to export/,
    );
    expect(() => runJobKind({ kind: "publish", ...NONE }, r)).toThrow(/unknown job kind: publish/);
    expectOnly(r, null);
  });
});
