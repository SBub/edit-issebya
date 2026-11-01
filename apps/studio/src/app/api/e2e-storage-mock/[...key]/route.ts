import { NextResponse } from "next/server";
import {
  e2eStorageRoot,
  fakeStorage,
  isDownloadName,
  isE2EMockStorage,
  isPartNumber,
  isStorageKey,
  isUploadId,
} from "@edit-issebya/storage";
import { MOCK_UPLOAD_URL_BASE } from "@/lib/storage";

/**
 * E2E-only stand-in for R2. Under E2E_MOCK_STORAGE=true the fake storage signs
 * upload part URLs that point here (`<key>?uploadId=..&partNumber=n`), so the
 * browser PUTs each part of a multipart upload to this route in place of R2.
 * The part lands under the gitignored `.e2e-storage/.multipart/` folder at the
 * repository root, and the answer carries its ETag (the quoted MD5 of the
 * part, as R2's); completing the upload assembles the object there, where the
 * worker reads it. There is no single-object PUT. GET returns the bytes
 * (honouring a single `Range`, as R2 does, so a video can seek), HEAD their
 * size. A `download=<name>` parameter (the fake's signDownload with a
 * downloadName) makes the GET an attachment with that name, as R2's
 * response-content-disposition does.
 *
 * Every method 404s unless E2E_MOCK_STORAGE is exactly "true", so the route is
 * inert in `yarn dev` and production, and never receives a body there.
 */
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ key: string[] }>;
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

async function storageKey({ params }: Context): Promise<string | null> {
  const { key } = await params;
  const joined = key.join("/");
  return isStorageKey(joined) ? joined : null;
}

function storage() {
  return fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: MOCK_UPLOAD_URL_BASE });
}

// R2's UploadPart: one part of a multipart upload the fake created.
export async function PUT(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return NextResponse.json({ error: "Bad key" }, { status: 400 });
  const query = new URL(request.url).searchParams;
  const uploadId = query.get("uploadId");
  const partText = query.get("partNumber") ?? "";
  const partNumber = /^\d{1,5}$/.test(partText) ? Number(partText) : NaN;
  if (!isUploadId(uploadId) || !isPartNumber(partNumber)) {
    return NextResponse.json({ error: "Bad part" }, { status: 400 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  let etag: string;
  try {
    etag = await storage().putUploadPart(key, { uploadId, partNumber, body });
  } catch {
    return NextResponse.json({ error: "No such upload" }, { status: 404 });
  }
  return new NextResponse(null, {
    status: 200,
    headers: { ETag: `"${etag}"`, "Access-Control-Expose-Headers": "ETag" },
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
};

function contentType(key: string): string {
  const dot = key.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[key.slice(dot)]) || "application/octet-stream";
}

// One `bytes=a-b`, `bytes=a-` or `bytes=-n` range over `size` bytes, as R2
// answers it: the inclusive slice, "unsatisfiable", or null for no (or an
// unparsed) range, which serves the whole object.
function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

// `Content-Disposition` for a well-formed `download` parameter, else nothing.
function disposition(request: Request): Record<string, string> {
  const name = new URL(request.url).searchParams.get("download");
  if (name === null || !isDownloadName(name)) return {};
  return { "Content-Disposition": `attachment; filename="${name}"` };
}

export async function GET(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return NextResponse.json({ error: "Bad key" }, { status: 400 });
  const body = await storage().get(key);
  if (!body) return notFound();
  const type = contentType(key);
  const range = byteRange(request.headers.get("range"), body.byteLength);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${body.byteLength}`, "Accept-Ranges": "bytes" },
    });
  }
  if (range) {
    const slice = body.slice(range.start, range.end + 1);
    return new NextResponse(new Blob([slice as Uint8Array<ArrayBuffer>]), {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Type": type,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
        ...disposition(request),
      },
    });
  }
  return new NextResponse(new Blob([body as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      ...disposition(request),
    },
  });
}

export async function HEAD(_request: Request, context: Context) {
  if (!isE2EMockStorage()) return new NextResponse(null, { status: 404 });
  const key = await storageKey(context);
  if (!key) return new NextResponse(null, { status: 400 });
  const info = await storage().head(key);
  if (!info) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, {
    status: 200,
    headers: { "Content-Length": String(info.bytes) },
  });
}
