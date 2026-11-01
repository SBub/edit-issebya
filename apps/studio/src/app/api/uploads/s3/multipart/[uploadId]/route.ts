import { answer, uploadDeps } from "@/lib/upload-routes";
import { abortUpload, listParts } from "@/lib/upload-server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ uploadId: string }>;
}

// The parts storage already holds (a resumed upload skips them). The `key`
// query parameter Uppy sends is ignored: the key comes from the reel row.
export async function GET(_request: Request, { params }: Context) {
  const { uploadId } = await params;
  return answer(await listParts(await uploadDeps(), { uploadId }), (parts) => parts);
}

// Cancel: storage drops the parts, the reel becomes `failed`.
export async function DELETE(_request: Request, { params }: Context) {
  const { uploadId } = await params;
  return answer(await abortUpload(await uploadDeps(), { uploadId }), () => ({}));
}
