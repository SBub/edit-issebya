import { copyFile, link, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildAsset } from "@edit-issebya/edit";

export interface RenderProject {
  // The project folder, created if missing.
  dir: string;
  // The page exactly as `build` returned it.
  html: string;
  assets: BuildAsset[];
  // The full-size pipeline outputs, already on disk.
  files: { footage: string; cutout: string };
}

// A relative path with no `..` segment: it stays inside the project.
function assertProjectPath(path: string): string {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error(`render: asset path outside the project: ${JSON.stringify(path)}`);
  }
  return path;
}

// A hard link where the file system allows it (no copy of a large file), else
// a copy.
async function place(from: string, to: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  await mkdir(dirname(to), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  await link(from, to).catch(() => copyFile(from, to));
}

// packages/edit's own asset (a font or a sound), resolved as edit-measurer.ts does.
function editAsset(path: string): string {
  return fileURLToPath(import.meta.resolve(`@edit-issebya/edit/${path}`));
}

// The temporary HyperFrames project a render reads: `index.html` and every
// asset the page names at its own path (footage and cut-out from the given
// files, fonts and sounds from packages/edit). Returns every file written, the
// render step's inputs.
export async function writeRenderProject({
  dir,
  html,
  assets,
  files,
}: RenderProject): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  await mkdir(dir, { recursive: true });
  const page = join(dir, "index.html");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  await writeFile(page, html);
  const written = [page];
  for (const asset of assets) {
    const to = join(dir, assertProjectPath(asset.path));
    const from =
      asset.role === "footage"
        ? files.footage
        : asset.role === "cutout"
          ? files.cutout
          : editAsset(asset.path);
    await place(from, to);
    written.push(to);
  }
  return written;
}
