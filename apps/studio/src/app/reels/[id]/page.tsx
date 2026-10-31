import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { LiveReel } from "@/components/LiveReel";
import { NotConfigured } from "@/components/NotConfigured";
import { StudioIdentify } from "@/components/StudioIdentify";
import { JOB_COLUMNS, type JobRow, STEP_COLUMNS, type StepRow } from "@/lib/jobs";
import type { ReelDetail } from "@/lib/reels";
import { REEL_DETAIL_COLUMNS, isReelId, reelName } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// Reads the reel, its jobs and its steps once on the server; LiveReel then
// follows changes through Realtime. No polling, no interval.
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

  // The step log is loaded only here, for the open reel.
  const [jobs, steps] = await Promise.all([
    supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("reel_id", id)
      .order("created_at")
      .returns<JobRow[]>(),
    supabase
      .from("steps")
      .select(STEP_COLUMNS)
      .eq("reel_id", id)
      .order("started_at")
      .returns<StepRow[]>(),
  ]);
  if (jobs.error) throw new Error(`studio: jobs not loaded: ${jobs.error.message}`);
  if (steps.error) throw new Error(`studio: steps not loaded: ${steps.error.message}`);

  return (
    <article className="flex flex-col gap-4">
      <StudioIdentify userId={user.id} />
      <Link href="/" className="text-sm text-stone-600 underline">
        Back to your reels
      </Link>
      <h1 className="text-2xl font-semibold break-all">{reelName(reel)}</h1>
      <LiveReel reel={reel} jobs={jobs.data ?? []} steps={steps.data ?? []} />
    </article>
  );
}
