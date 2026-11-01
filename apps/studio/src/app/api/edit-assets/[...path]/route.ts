import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { EDIT_ASSET_FILES } from "@/lib/edit-assets";

/**
 * The preset's fonts and click sound, from packages/edit/assets/ (the live
 * preview's built page names them). Only the files the preset names are
 * served; anything else, a traversal included, is a 404. The files never
 * change for a path, so they are cached for a year.
 */
interface Context {
  params: Promise<{ path: string[] }>;
}

// packages/edit, from the studio's folder (`next dev`, `next start` and the
// traced server output all run there; see outputFileTracingIncludes).
function editPackageDir(): string {
  return join(process.cwd(), "..", "..", "packages", "edit");
}

export async function GET(_request: Request, { params }: Context) {
  const { path } = await params;
  const joined = path.join("/");
  const type = EDIT_ASSET_FILES.get(joined);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an allow-listed preset path
  const body = await readFile(join(editPackageDir(), joined));
  return new NextResponse(new Blob([body]), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
