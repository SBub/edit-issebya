import { NextResponse } from "next/server";
import { e2eStorageRoot, fakeStorage, isE2EMockStorage, isStorageKey } from "@edit-issebya/storage";
import { MOCK_UPLOAD_URL_BASE } from "@/lib/storage";

/**
 * E2E-only stand-in for R2. Under E2E_MOCK_STORAGE=true the fake storage signs
 * upload URLs that point here, so the browser PUTs the file to this route in
 * place of R2, and the bytes land in the gitignored `.e2e-storage/` folder at
 * the repository root, where the worker reads them. GET returns the bytes,
 * HEAD their size.
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

export async function PUT(request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return NextResponse.json({ error: "Bad key" }, { status: 400 });
  const body = new Uint8Array(await request.arrayBuffer());
  await storage().put(key, body);
  return new NextResponse(null, {
    status: 200,
    headers: { ETag: `"${body.byteLength}-${Date.now()}"` },
  });
}

export async function GET(_request: Request, context: Context) {
  if (!isE2EMockStorage()) return notFound();
  const key = await storageKey(context);
  if (!key) return NextResponse.json({ error: "Bad key" }, { status: 400 });
  const body = await storage().get(key);
  if (!body) return notFound();
  return new NextResponse(new Blob([body as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: { "Content-Length": String(body.byteLength) },
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
