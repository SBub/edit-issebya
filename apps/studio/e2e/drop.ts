import { readFile } from "node:fs/promises";
import type { JSHandle, Locator, Page } from "@playwright/test";

// A file for a synthetic drop: a committed fixture's bytes (`path`), bytes
// made by the spec (`bytes`) or a short text (`text`), under the name and type
// the browser reports.
export interface DropFile {
  name: string;
  type: string;
  path?: string;
  bytes?: Buffer;
  text?: string;
}

/**
 * The JPEG as a phone held upright stores it: the same pixels, with an EXIF
 * block that holds only the Orientation tag (6: turn a quarter clockwise to
 * show it), put right after the start marker.
 */
export function turnedJpeg(jpeg: Buffer, orientation = 6): Buffer {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1];
  const body = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from([...tiff, 0, orientation, 0, 0, 0, 0, 0, 0]),
  ]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
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
      base64: (file.path
        ? // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed fixture
          await readFile(file.path)
        : (file.bytes ?? Buffer.from(file.text ?? ""))
      ).toString("base64"),
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
