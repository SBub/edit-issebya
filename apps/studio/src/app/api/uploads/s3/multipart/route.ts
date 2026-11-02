import { answer, badRequest, jsonBody, uploadDeps, uploadPrefix } from "@/lib/upload-routes";
import { createUpload } from "@/lib/upload-server";

export const dynamic = "force-dynamic";

// Creates the reel and its multipart upload. Body (Uppy's Companion protocol):
// `{ filename, type, metadata: { bytes } }`.
export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (!body) return badRequest();
  const metadata = (typeof body.metadata === "object" && body.metadata) || {};
  const bytes = Number((metadata as Record<string, unknown>).bytes);
  const result = await createUpload(
    { ...(await uploadDeps()), prefix: uploadPrefix() },
    { name: body.filename, type: body.type, bytes },
  );
  return answer(result, ({ key, uploadId }) => ({ key, uploadId }));
}
