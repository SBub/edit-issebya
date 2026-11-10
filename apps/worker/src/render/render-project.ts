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
  // The full-size footage and the masks, already on disk; masks by the path
  // the page names them at.
  files: RenderFiles;
}

export interface RenderFiles {
  footage: string;
  masks?: Record<string, string>;
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

// Where an asset comes from: the footage or a mask from the given files (one
// missing throws), a font or a sound from packages/edit.
function sourceOf(asset: BuildAsset, files: RenderFiles): string {
  const given = (from: Record<string, string> | undefined) => {
    const path = from?.[asset.path];
    if (!path) throw new Error(`render: no file for ${asset.role} ${asset.path}`);
    return path;
  };
  switch (asset.role) {
    case "footage":
      return files.footage;
    case "mask":
      return given(files.masks);
    default:
      return editAsset(asset.path);
  }
}

// The temporary HyperFrames project a render reads: `index.html` and every
// asset the page names at its own path (the footage and masks from the given
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
    await place(sourceOf(asset, files), to);
    written.push(to);
  }
  return written;
}
