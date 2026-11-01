import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { ISSEBYA } from "@edit-issebya/edit";

/**
 * The preset's fonts and click sounds for the live preview, same-origin, from
 * the edit package's `assets/` folder (traced into this route's output by
 * next.config.ts). Only a file the preset names is served; anything else is a
 * 404.
 */
interface Context {
  params: Promise<{ path: string[] }>;
}

const TYPES = new Map<string, string>([
  ...Object.values(ISSEBYA.fonts).map((font) => [font.file, "font/ttf"] as const),
  ...Object.values(ISSEBYA.sounds).map((sound) => [sound.file, "audio/wav"] as const),
]);

// The app's folder at run time (next dev, next start and Vercel alike).
const ASSETS = join(process.cwd(), "..", "..", "packages", "edit", "assets");

export async function GET(_request: Request, { params }: Context) {
  const file = (await params).path.join("/");
  const type = TYPES.get(file);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file the preset names, inside the edit package
  const body = await readFile(join(ASSETS, file));
  return new NextResponse(new Blob([body]), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
