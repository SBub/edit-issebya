import { NextResponse } from "next/server";
import {
  MultipartError,
  e2eStorageRoot,
  fakeMultipart,
  fakeStorage,
  isE2EMockStorage,
  isPartNumber,
  isStorageKey,
} from "@edit-issebya/storage";
import { MOCK_UPLOAD_URL_BASE } from "@/lib/storage";

/**
 * E2E-only stand-in for R2's S3 API, multipart included. Under
 * E2E_MOCK_STORAGE=true the fake storage signs URLs that point here, so the
 * browser sends its multipart requests to this route in place of R2: create
 * (`POST ?uploads`), each part (`PUT ?partNumber&uploadId`), list
 * (`GET ?uploadId`), complete (`POST ?uploadId`) and abort
 * (`DELETE ?uploadId`). The parts and the assembled object land in the
 * gitignored `.e2e-storage/` folder at the repository root, where the worker
 * reads them. A plain GET returns the object's bytes, HEAD its size.
 *
 * Every method 404s unless E2E_MOCK_STORAGE is exactly "true", so the route is
 * inert in `yarn dev` and production, and never receives a body there.
 */
export const dynamic = "force-dynamic";

const BUCKET = "e2e";

interface Context {
  params: Promise<{ key: string[] }>;
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

async function storageKey({ params }: Context): Promise<string | null> {
  const { key } = await params;
  const joined = key.join("/");
  return isStorageKey(joined) ? joined : null;
}

function root() {
  return e2eStorageRoot();
}

function storage() {
  return fakeStorage({ root: root(), uploadUrlBase: MOCK_UPLOAD_URL_BASE });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// One XML element; text values are escaped, nested elements passed as built.
function element(name: string, ...children: (string | number)[]): string {
  return `<${name}>${children.join("")}</${name}>`;
}

function text(value: string): string {
  return escapeXml(value);
}

function xml(body: string, status = 200) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

// S3's error answer, so the uploader reads the code as it would from R2.
function s3Error(error: unknown) {
  if (error instanceof MultipartError) {
    const status = error.name === "NoSuchUpload" ? 404 : 400;
    return xml(
      element("Error", element("Code", error.name), element("Message", text(error.message))),
      status,
    );
  }
  throw error;
}

function uploadIdOf(request: Request): string | null {
  return new URL(request.url).searchParams.get("uploadId");
}

// The `<Part>` pairs of a CompleteMultipartUpload body. A small tag scanner,
// no regular expression over the whole body.
function completedParts(body: string): { partNumber: number; etag: string }[] | null {
  const parts: { partNumber: number; etag: string }[] = [];
  let from = 0;
  for (;;) {
    const start = body.indexOf("<Part>", from);
    if (start < 0) break;
    const end = body.indexOf("</Part>", start);
    if (end < 0) return null;
    const inner = body.slice(start + "<Part>".length, end);
    const number = Number(between(inner, "PartNumber"));
    const etag = between(inner, "ETag");
    if (!isPartNumber(number) || !etag) return null;
    parts.push({ partNumber: number, etag: etag.replaceAll("&quot;", '"') });
    from = end + "</Part>".length;
  }
  return parts;
}

function between(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(`</${tag}>`, start);
  if (end < 0) return null;
  return text.slice(start + open.length, end).trim();
}

export async function POST(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return badRequest("Bad key");
  const params = new URL(request.url).searchParams;
  const multipart = fakeMultipart({ root: root() });

  if (params.has("uploads")) {
    const uploadId = await multipart.create(key);
    return xml(
      element(
        "InitiateMultipartUploadResult",
        element("Bucket", BUCKET),
        element("Key", text(key)),
        element("UploadId", uploadId),
      ),
    );
  }

  const uploadId = params.get("uploadId");
  if (!uploadId) return badRequest("Missing uploadId");
  const parts = completedParts(await request.text());
  if (!parts) return badRequest("Bad parts list");
  try {
    const etag = await multipart.complete(key, uploadId, parts);
    const location = new URL(`${MOCK_UPLOAD_URL_BASE}${key}`, request.url).href;
    return xml(
      element(
        "CompleteMultipartUploadResult",
        element("Location", text(location)),
        element("Bucket", BUCKET),
        element("Key", text(key)),
        element("ETag", text(etag)),
      ),
    );
  } catch (error) {
    return s3Error(error);
  }
}

export async function PUT(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return badRequest("Bad key");
  const params = new URL(request.url).searchParams;
  const uploadId = params.get("uploadId");
  const partNumber = Number(params.get("partNumber"));
  // The plain object PUT went with the single-PUT upload.
  if (!uploadId || !isPartNumber(partNumber)) return badRequest("Only multipart parts");
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    const etag = await fakeMultipart({ root: root() }).putPart(key, uploadId, partNumber, body);
    return new NextResponse(null, { status: 200, headers: { ETag: etag } });
  } catch (error) {
    return s3Error(error);
  }
}

export async function GET(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return badRequest("Bad key");

  const uploadId = uploadIdOf(request);
  if (uploadId !== null) {
    try {
      const parts = await fakeMultipart({ root: root() }).listParts(key, uploadId);
      const listed = parts.map((part) =>
        element(
          "Part",
          element("PartNumber", part.partNumber),
          element("ETag", text(part.etag)),
          element("Size", part.size),
        ),
      );
      return xml(
        element(
          "ListPartsResult",
          element("Bucket", BUCKET),
          element("Key", text(key)),
          element("UploadId", text(uploadId)),
          element("IsTruncated", "false"),
          ...listed,
        ),
      );
    } catch (error) {
      return s3Error(error);
    }
  }

  const body = await storage().get(key);
  if (!body) return notFound();
  return new NextResponse(new Blob([body as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: { "Content-Length": String(body.byteLength) },
  });
}

export async function DELETE(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return badRequest("Bad key");
  const uploadId = uploadIdOf(request);
  if (!uploadId) return badRequest("Missing uploadId");
  await fakeMultipart({ root: root() }).abort(key, uploadId);
  return new NextResponse(null, { status: 204 });
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
