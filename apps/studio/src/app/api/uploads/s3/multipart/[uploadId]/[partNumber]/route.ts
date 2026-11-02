import { answer, uploadDeps } from "@/lib/upload-routes";
import { signPart } from "@/lib/upload-server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ uploadId: string; partNumber: string }>;
}

// A URL the browser PUTs one part to, signed for the reel row's key.
export async function GET(_request: Request, { params }: Context) {
  const { uploadId, partNumber } = await params;
  return answer(await signPart(await uploadDeps(), { uploadId, partNumber }), ({ url }) => ({
    url,
  }));
}
