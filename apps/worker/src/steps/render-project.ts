import { copyFile, link, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildResult } from "@edit-issebya/edit";

// A HyperFrames project needs nothing but its entry, `index.html`, and the
// files the page names beside it.
const PROJECT_ENTRY = "index.html";

// The local file is linked when it can be (same disk), else copied.
async function place(from: string, to: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  await mkdir(dirname(to), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  await link(from, to).catch(() => copyFile(from, to));
}

// The preset's font or sound file inside the edit package.
function packageAsset(path: string): URL {
  if (!path.startsWith("assets/") || path.split("/").includes("..")) {
    throw new Error(`render: unexpected asset path: ${path}`);
  }
  return new URL(import.meta.resolve(`@edit-issebya/edit/${path}`));
}

// Writes the temporary project the render reads: the built page unchanged
// (the worker never edits it), the full-size footage and cut-out under the
// names the page uses, and each font and sound from the edit package.
export async function writeRenderProject({
  dir,
  build,
  footagePath,
  cutoutPath,
}: {
  dir: string;
  build: Pick<BuildResult, "html" | "assets">;
  footagePath: string;
  cutoutPath: string;
}): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  await mkdir(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  await writeFile(join(dir, PROJECT_ENTRY), build.html);
  for (const asset of build.assets) {
    const to = join(dir, asset.path);
    switch (asset.role) {
      case "footage":
        await place(footagePath, to);
        break;
      case "cutout":
        await place(cutoutPath, to);
        break;
      case "font":
      case "sound":
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
        await mkdir(dirname(to), { recursive: true });
        await copyFile(packageAsset(asset.path), to);
        break;
      default:
        throw new Error(`render: unknown asset role: ${String((asset as { role: unknown }).role)}`);
    }
  }
}
