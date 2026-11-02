import { rename, writeFile } from "node:fs/promises";

// Written as `<path>.part`, then renamed: a half-written file never has the
// final name, so the runner never uploads one.
export async function writeAtomic(path: string, text: string): Promise<void> {
  const partial = `${path}.part`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  await writeFile(partial, text);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  await rename(partial, path);
}
