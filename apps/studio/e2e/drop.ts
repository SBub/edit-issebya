import { readFile } from "node:fs/promises";
import type { JSHandle, Locator, Page } from "@playwright/test";

// A file for a synthetic drop: a committed fixture's bytes (`path`) or a short
// text (`text`), under the name and type the browser reports.
export interface DropFile {
  name: string;
  type: string;
  path?: string;
  text?: string;
}

/**
 * A DataTransfer built in the page holding the files, as a drag from the
 * desktop carries them (its types include "Files").
 */
export async function fileTransfer(
  page: Page,
  files: readonly DropFile[],
): Promise<JSHandle<DataTransfer>> {
  const payload = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      base64: file.path
        ? // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed fixture
          (await readFile(file.path)).toString("base64")
        : Buffer.from(file.text ?? "").toString("base64"),
    })),
  );
  return page.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const file of list) {
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    return transfer;
  }, payload);
}

/** What a drag that ends in a drop on the zone fires: enter, over, drop. */
export async function dropFiles(zone: Locator, dataTransfer: JSHandle<DataTransfer>) {
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer });
  await zone.dispatchEvent("drop", { dataTransfer });
}
