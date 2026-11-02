import { answer, badRequest, jsonBody, uploadDeps } from "@/lib/upload-routes";
import { completeUpload } from "@/lib/upload-server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ uploadId: string }>;
}

// Assembles the object and finishes the upload (idempotent). Body:
// `{ parts: [{ PartNumber, ETag }] }`.
export async function POST(request: Request, { params }: Context) {
  const body = await jsonBody(request);
  if (!body) return badRequest();
  const { uploadId } = await params;
  return answer(
    await completeUpload(await uploadDeps(), { uploadId, parts: body.parts }),
    ({ key }) => ({ key, location: key }),
  );
}
