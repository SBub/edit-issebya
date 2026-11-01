import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ISSEBYA } from "@edit-issebya/edit";
import { GET } from "./route";

function get(path: string[]) {
  return GET(new Request("http://x/"), { params: Promise.resolve({ path }) });
}

describe("GET /api/edit-assets", () => {
  it("serves a preset font with its bytes", async () => {
    const font = ISSEBYA.fonts[Object.keys(ISSEBYA.fonts)[0]!]!;
    const response = await get(font.file.split("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("font/ttf");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a preset font inside the edit package
    const expected = await readFile(
      new URL(`../../../../../../../packages/edit/assets/${font.file}`, import.meta.url),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(expected));
  });

  it("serves a preset sound as wav", async () => {
    const response = await get(ISSEBYA.sounds.click!.file.split("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("answers 404 to anything the preset does not name", async () => {
    expect((await get(["..", "package.json"])).status).toBe(404);
    expect((await get(["fonts", "Unknown.ttf"])).status).toBe(404);
    expect((await get(["fonts", "..", "..", "package.json"])).status).toBe(404);
  });
});
