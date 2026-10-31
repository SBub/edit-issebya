import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NotConfigured } from "@/components/NotConfigured";
import type { ReelDetail } from "@/lib/reels";
import { REEL_DETAIL_COLUMNS, formatBytes, formatCreatedAt, isReelId, reelName } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// Reads once on the server: no polling, no interval, no client fetch.
export default async function ReelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isReelId(id)) notFound();

  const supabase = await createSupabaseServerClient();
  if (!supabase) return <NotConfigured />;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: reel, error } = await supabase
    .from("reels")
    .select(REEL_DETAIL_COLUMNS)
    .eq("id", id)
    .returns<ReelDetail[]>()
    .maybeSingle();
  if (error) throw new Error(`studio: reel not loaded: ${error.message}`);
  if (!reel) notFound();

  return (
    <article className="flex flex-col gap-4">
      <Link href="/" className="text-sm text-stone-600 underline">
        Back to your reels
      </Link>
      <h1 className="text-2xl font-semibold break-all">{reelName(reel)}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-stone-600">Status</dt>
        <dd data-testid="reel-status">{reel.status}</dd>
        <dt className="text-stone-600">Size</dt>
        <dd>{formatBytes(reel.source_bytes)}</dd>
        <dt className="text-stone-600">Created</dt>
        <dd>
          <time dateTime={reel.created_at}>{formatCreatedAt(reel.created_at)}</time>
        </dd>
      </dl>
    </article>
  );
}
