import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

function get(path: string[]) {
  return GET(new Request("http://x/"), { params: Promise.resolve({ path }) });
}

describe("GET /api/edit-assets/[...path]", () => {
  it("serves a preset font with its bytes, type and cache header", async () => {
    const answer = await get(["assets", "fonts", "GolosText-Bold.ttf"]);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("Content-Type")).toBe("font/ttf");
    expect(answer.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's committed font
    const expected = await readFile(
      new URL(
        "../../../../../../../packages/edit/assets/fonts/GolosText-Bold.ttf",
        import.meta.url,
      ),
    );
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(new Uint8Array(expected));
  });

  it("serves the click sound as audio/wav", async () => {
    const answer = await get(["assets", "sounds", "mouse-click-trimmed.wav"]);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("answers 404 to a file the preset does not name", async () => {
    expect((await get(["assets", "fonts", "OFL-Raleway.txt"])).status).toBe(404);
    expect((await get(["package.json"])).status).toBe(404);
  });

  it("answers 404 to a traversal path", async () => {
    expect((await get(["..", "..", "package.json"])).status).toBe(404);
    expect((await get(["assets", "..", "assets", "fonts", "GolosText-Bold.ttf"])).status).toBe(404);
  });
});
