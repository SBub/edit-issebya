import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSEBYA_PRESET, build } from "@edit-issebya/edit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editMeasurer } from "../edit-measurer.ts";
import { writeRenderProject } from "./render-project.ts";
import { fixtureEdit, fixturePath } from "./render-test-support.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-project-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FILES = {
  footage: fixturePath("retime", "source.mp4"),
  cutout: fixturePath("remove_background", "subject.webm"),
};

describe("writeRenderProject", () => {
  it("writes the page and every asset at the path the page names", async () => {
    const { edit, transcript, headTrack } = await fixtureEdit();
    const { html, assets } = build(
      edit,
      transcript,
      headTrack,
      ISSEBYA_PRESET,
      await editMeasurer(),
    );
    const written = await writeRenderProject({ dir, html, assets, files: FILES });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder and the committed fixtures
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(html);
    expect(written).toEqual([join(dir, "index.html"), ...assets.map((a) => join(dir, a.path))]);
    expect(assets.map((a) => a.role)).toEqual(
      expect.arrayContaining(["footage", "cutout", "font"]),
    );
    for (const asset of assets) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder and the committed fixtures
      const placed = await stat(join(dir, asset.path));
      expect(placed.size).toBeGreaterThan(0);
    }
    const footage = assets.find((a) => a.role === "footage")!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder and the committed fixtures
    expect(await readFile(join(dir, footage.path))).toEqual(await readFile(FILES.footage));
  });

  it("refuses an asset path outside the project", async () => {
    for (const path of ["../escape.mp4", "/abs/x.ttf", "assets/../../x.wav"]) {
      await expect(
        writeRenderProject({
          dir,
          html: "<html></html>",
          assets: [{ path, role: "font", ref: null }],
          files: FILES,
        }),
      ).rejects.toThrow(/outside the project/);
    }
  });
});
