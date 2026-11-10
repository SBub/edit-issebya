import type { ExportRef } from "@/lib/exports";
import { notFound, redirect } from "next/navigation";
import { LiveReel } from "@/components/LiveReel";
import { NotConfigured } from "@/components/NotConfigured";
import { PhotoLibrary } from "@/components/PhotoLibrary";
import { StudioIdentify } from "@/components/StudioIdentify";
import { serverErrorCapture } from "@/lib/error-tracking";
import { JOB_COLUMNS, type JobRow, STEP_COLUMNS, type StepRow } from "@/lib/jobs";
import { ESTIMATE_LAST_ROWS, type HistoryRow, PROGRESS_STEPS, historyRates } from "@/lib/progress";
import type { ReelDetail } from "@/lib/reels";
import { loadLibrary } from "@/lib/photo-server";
import { REEL_DETAIL_COLUMNS, isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { pairOfProfile } from "@/lib/font-pair-faces";
import { readVersionFontPair } from "@/lib/version-font-pair";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { VERSION_LIST_COLUMNS, type VersionListRow } from "@/lib/versions";
import { WORKER_STATUS_COLUMNS, type WorkerStatusRow } from "@/lib/worker-status";

// Reads the reel, its jobs, its steps, its versions, its newest export's id,
// every worker's status row, the owner's photo library and profile, the font pair
// of the current version and, per long step, the owner's newest earlier
// done rows (the time-left history) once on the server; LiveReel then
// follows changes through Realtime. No polling, no interval.
export default async function ReelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isReelId(id)) notFound();

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <NotConfigured />
      </main>
    );
  }

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
  // The owner's earlier done rows of one long step whose reel knows its
  // footage length (RLS: only the owner's steps), newest first.
  const history = (name: string) =>
    supabase
      .from("steps")
      .select("wall_ms, reels!inner(footage_seconds)")
      .eq("name", name)
      .eq("status", "done")
      .not("reels.footage_seconds", "is", null)
      .order("finished_at", { ascending: false })
      .limit(ESTIMATE_LAST_ROWS)
      .returns<HistoryRow[]>();

  const [
    library,
    jobs,
    steps,
    versions,
    latestExport,
    workerStatus,
    profile,
    currentPair,
    ...histories
  ] = await Promise.all([
    loadLibrary({ supabase, storage: studioStorage(), errors: serverErrorCapture() }),
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
    supabase
      .from("versions")
      .select(VERSION_LIST_COLUMNS)
      .eq("reel_id", id)
      .order("number")
      .returns<VersionListRow[]>(),
    supabase
      .from("exports")
      .select("id, job_id")
      .eq("reel_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<ExportRef>(),
    supabase.from("worker_status").select(WORKER_STATUS_COLUMNS).returns<WorkerStatusRow[]>(),
    supabase
      .from("profiles")
      .select("font_pair")
      .eq("user_id", user.id)
      .maybeSingle<{ font_pair: string }>(),
    // The pair the current version was set in (its edit), not the profile's.
    reel.current_version_id
      ? readVersionFontPair({
          supabase,
          storage: studioStorage(),
          reelId: id,
          versionId: reel.current_version_id,
          userId: user.id,
        }).then((fontPair) => ({ versionId: reel.current_version_id!, fontPair }))
      : Promise.resolve(null),
    ...PROGRESS_STEPS.map(history),
  ]);
  if (jobs.error) throw new Error(`studio: jobs not loaded: ${jobs.error.message}`);
  if (steps.error) throw new Error(`studio: steps not loaded: ${steps.error.message}`);
  if (versions.error) throw new Error(`studio: versions not loaded: ${versions.error.message}`);
  if (latestExport.error) {
    throw new Error(`studio: exports not loaded: ${latestExport.error.message}`);
  }
  if (workerStatus.error) {
    throw new Error(`studio: worker status not loaded: ${workerStatus.error.message}`);
  }
  const estimateRates: Record<string, number[]> = {};
  for (const [index, name] of PROGRESS_STEPS.entries()) {
    const result = histories[index]!;
    if (result.error) throw new Error(`studio: step history not loaded: ${result.error.message}`);
    estimateRates[name] = historyRates(result.data ?? []);
  }

  // LiveReel owns the whole screen, header (back link, name, Export) included.
  return (
    <>
      <StudioIdentify userId={user.id} />
      <LiveReel
        reel={reel}
        jobs={jobs.data ?? []}
        steps={steps.data ?? []}
        versions={versions.data ?? []}
        latestExport={latestExport.data ?? null}
        workerStatus={workerStatus.data ?? []}
        estimateRates={estimateRates}
        library={<PhotoLibrary initial={library.ok ? library.value : []} />}
        fontPair={pairOfProfile(profile.data)}
        currentFontPair={currentPair}
      />
    </>
  );
}
