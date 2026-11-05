"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { requestRetry } from "@/app/retry-actions";
import {
  JOB_COLUMNS,
  type JobRow,
  STEP_COLUMNS,
  type StepRow,
  pickColumns,
  upsertById,
} from "@/lib/jobs";
import { type ChangeRequestHandle, ChangeRequestForm } from "@/components/ChangeRequestForm";
import { ExportPanel } from "@/components/ExportPanel";
import { ProgressOverlay } from "@/components/ProgressOverlay";
import { ReelPreview } from "@/components/ReelPreview";
import { ReelScreen } from "@/components/ReelScreen";
import { StartOverButton } from "@/components/StartOverButton";
import { VersionList } from "@/components/VersionList";
import { changeBlockedReason } from "@/lib/change-requests";
import type { ExportRef } from "@/lib/exports";
import { changeQueueNote } from "@/lib/failures";
import { type FailureAction, overlayState } from "@/lib/progress-overlay";
import { REEL_DETAIL_COLUMNS, type ReelDetail, reelName } from "@/lib/reels";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import { capture, reportBrowserFailure } from "@/lib/track";
import { VERSION_LIST_COLUMNS, type VersionListRow } from "@/lib/versions";
import {
  WORKER_STATUS_COLUMNS,
  type WorkerStatusRow,
  upsertWorkerStatus,
  waitingReasonOf,
} from "@/lib/worker-status";
import { offlineAt, offlineSince } from "@/lib/worker-offline";

interface Snapshot {
  reel: ReelDetail;
  jobs: JobRow[];
  steps: StepRow[];
  versions: VersionListRow[];
  // The newest export and its job: the export modal downloads its job's
  // export the moment it arrives.
  latestExport: ExportRef | null;
  // Every worker's row: why it is not claiming (free disk) and its heartbeat.
  workerStatus: WorkerStatusRow[];
}

interface LiveReelProps extends Snapshot {
  // Per long step, the owner's earlier done rows as ms per footage second,
  // newest first: read once per page open, the time-left estimate's history.
  estimateRates: Record<string, number[]>;
  // The owner's photo library (it follows its own table), shown beside the
  // reel on desktop and as the phone's Library tab.
  library: ReactNode;
}

// How long "New version N" shows after a save.
const NEW_VERSION_NOTICE_MS = 4000;

// Realtime statuses that mean the page stopped following the reel.
const DROPPED_STATUSES = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

async function readSnapshot(supabase: SupabaseClient, id: string): Promise<Snapshot | null> {
  const [reel, jobs, steps, versions, latestExport, workerStatus] = await Promise.all([
    supabase.from("reels").select(REEL_DETAIL_COLUMNS).eq("id", id).maybeSingle<ReelDetail>(),
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
  ]);
  if (
    reel.error ||
    jobs.error ||
    steps.error ||
    versions.error ||
    latestExport.error ||
    workerStatus.error
  ) {
    return null;
  }
  if (!reel.data) return null;
  return {
    reel: reel.data,
    jobs: jobs.data ?? [],
    steps: steps.data ?? [],
    versions: versions.data ?? [],
    latestExport: latestExport.data ?? null,
    workerStatus: workerStatus.data ?? [],
  };
}

// The reel page on one screen (ReelScreen): the header with Export, the
// current version's preview and tracks timeline, the progress
// overlay over the preview (what the studio is doing in plain words, how far
// along, the waiting and offline lines, "New version N", a failure with its
// actions), the change box and the versions. A newly saved version replaces
// the preview by itself, at the same time and play state. Read once on the
// server, then followed through Realtime filtered to this reel (RLS decides
// what arrives). One catch-up read each time the subscription becomes ready
// covers changes made between the server read and the subscription. No
// interval, no polling.
export function LiveReel({
  reel: initialReel,
  jobs: initialJobs,
  steps: initialSteps,
  versions: initialVersions,
  latestExport: initialLatestExport,
  workerStatus: initialWorkerStatus,
  estimateRates,
  library,
}: LiveReelProps) {
  const [reel, setReel] = useState(initialReel);
  const [jobs, setJobs] = useState(initialJobs);
  const [steps, setSteps] = useState(initialSteps);
  const [versions, setVersions] = useState(initialVersions);
  const [latestExport, setLatestExport] = useState(initialLatestExport);
  const [workerStatus, setWorkerStatus] = useState(initialWorkerStatus);
  const [ready, setReady] = useState(false);
  // The clock the offline line reads: set after mount (never on the server,
  // whose time and time zone are not the owner's), then once more at the
  // moment the newest heartbeat turns eleven minutes old. One timeout, no
  // interval, no database read.
  const [now, setNow] = useState<number | null>(null);
  // Failed jobs the owner handled on this page load (memory only: a reload
  // shows a still-unhandled failure again).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // "New version N": the version whose notice shows, set when the current
  // version changes after the first render (derived during render, no
  // effect), cleared by one timeout.
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [lastCurrentId, setLastCurrentId] = useState(initialReel.current_version_id);
  if (reel.current_version_id !== lastCurrentId) {
    setLastCurrentId(reel.current_version_id);
    if (reel.current_version_id) setNoticeId(reel.current_version_id);
  }
  // Try again's busy flag and message belong to one failed job, so a later
  // failure (for example the retry's own) starts fresh.
  const [retry, setRetry] = useState<{ jobId: string; busy: boolean; message: string } | null>(
    null,
  );
  const changeForm = useRef<ChangeRequestHandle>(null);
  const router = useRouter();
  const id = initialReel.id;
  const offlineMoment = offlineAt(workerStatus)?.getTime() ?? null;

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const delay = offlineMoment === null ? null : offlineMoment - Date.now();
    const later = delay !== null && delay > 0 ? setTimeout(tick, delay) : undefined;
    return () => {
      clearTimeout(first);
      clearTimeout(later);
    };
  }, [offlineMoment]);

  useEffect(() => {
    if (noticeId === null) return;
    const timer = setTimeout(() => setNoticeId(null), NEW_VERSION_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noticeId]);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    let active = true;
    const channel = supabase.channel(`reel-${id}-${crypto.randomUUID()}`);

    channel
      .on("system", {}, (message: { extension?: string; status?: string }) => {
        // "Subscribed to PostgreSQL": the listeners below are attached now.
        if (message.extension !== "postgres_changes" || message.status !== "ok") return;
        void readSnapshot(supabase, id).then((snapshot) => {
          if (!active) return;
          if (snapshot) {
            setReel(snapshot.reel);
            setJobs(snapshot.jobs);
            setSteps(snapshot.steps);
            setVersions(snapshot.versions);
            setLatestExport(snapshot.latestExport);
            setWorkerStatus(snapshot.workerStatus);
          }
          setReady(true);
        });
      })
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "reels", filter: `id=eq.${id}` },
        (payload) => {
          setReel((current) => ({
            ...current,
            ...pickColumns<Partial<ReelDetail>>(payload.new, REEL_DETAIL_COLUMNS),
          }));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs", filter: `reel_id=eq.${id}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = pickColumns<JobRow>(payload.new, JOB_COLUMNS);
          setJobs((current) => upsertById(current, row, "created_at"));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "steps", filter: `reel_id=eq.${id}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = pickColumns<StepRow>(payload.new, STEP_COLUMNS);
          setSteps((current) => upsertById(current, row, "started_at"));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "versions", filter: `reel_id=eq.${id}` },
        (payload) => {
          // Versions are never updated, so inserts are all there is to follow.
          const row = pickColumns<VersionListRow>(payload.new, VERSION_LIST_COLUMNS);
          setVersions((current) => upsertById(current, row, "created_at"));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "exports", filter: `reel_id=eq.${id}` },
        (payload) => {
          // Exports are never updated; a new one is the newest.
          setLatestExport(pickColumns<ExportRef>(payload.new, "id, job_id"));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "worker_status" },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const row = pickColumns<WorkerStatusRow>(payload.new, WORKER_STATUS_COLUMNS);
          setWorkerStatus((current) => upsertWorkerStatus(current, row));
        },
      );

    // A dropped channel means the page stopped following the reel: reported
    // once per status change, never for the close an unmount causes.
    let lastStatus: string | null = null;
    const onStatus = (status: string) => {
      if (!active || status === lastStatus) return;
      lastStatus = status;
      if (DROPPED_STATUSES.has(status)) {
        reportBrowserFailure("studio: realtime channel dropped", { reel_id: id, status });
      }
    };

    // setAuth hands the session's token to Realtime before joining, so RLS
    // sees the owner.
    void supabase.realtime.setAuth().then(() => {
      if (active) channel.subscribe((status) => onStatus(status));
    });

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [id]);

  const blockedReason = changeBlockedReason(reel);
  const queueNote = changeQueueNote(jobs);
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const waitingReason = waitingReasonOf(workerStatus);
  const offline = now === null ? null : offlineSince(workerStatus, new Date(now));
  const currentId = reel.current_version_id;
  const overlay = overlayState({
    reel,
    jobs,
    steps,
    versionsById,
    waitingReason,
    offline,
    notice: noticeId ? (versionsById.get(noticeId)?.number ?? null) : null,
    dismissed,
    estimateRates,
  });
  const failure = overlay.kind === "failure" ? overlay : null;
  const retryForFailure = failure && retry?.jobId === failure.jobId ? retry : null;

  // Every overlay action names the failed job, so it links to its error.
  const recordAction = (action: FailureAction) => {
    if (!failure) return;
    capture("studio_failure_action", {
      reel_id: reel.id,
      job_id: failure.jobId,
      action,
      failure_kind: failure.failureKind,
      step: failure.step,
      job_kind: failure.jobKind,
    });
  };
  const dismiss = (jobId: string) => setDismissed((current) => new Set([...current, jobId]));

  async function tryAgain() {
    if (!failure) return;
    const jobId = failure.jobId;
    recordAction("try_again");
    setRetry({ jobId, busy: true, message: "" });
    try {
      const result = await requestRetry({ reelId: reel.id, jobId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") setRetry({ jobId, busy: true, message: "Queued again" });
      else if (result.status === "already")
        setRetry({ jobId, busy: true, message: "This job is already being retried" });
      else
        setRetry({
          jobId,
          busy: false,
          message: result.status === "failed" ? "Retry did not start. Try again" : result.reason,
        });
    } catch {
      setRetry({ jobId, busy: false, message: "Retry did not start. Try again" });
    }
  }

  function changeRequest() {
    if (!failure) return;
    const request = jobs.find((job) => job.id === failure.jobId)?.request ?? "";
    recordAction("change_request");
    dismiss(failure.jobId);
    changeForm.current?.refill(request);
  }

  function keepCurrent() {
    if (!failure) return;
    recordAction("keep_current");
    dismiss(failure.jobId);
  }

  return (
    <div data-realtime={ready ? "ready" : "pending"} className="h-dvh">
      <ReelScreen
        header={
          <>
            <Link
              href="/"
              aria-label="Back to your reels"
              className="flex flex-none items-center gap-1 px-2 py-1 text-sm text-muted hover:bg-raised hover:text-ink"
            >
              <span aria-hidden="true">&larr;</span>
              <span className="hidden sm:inline">Your reels</span>
            </Link>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={reelName(reel)}>
              {reelName(reel)}
            </h1>
            <ExportPanel
              reel={reel}
              jobs={jobs}
              steps={steps}
              versions={versions}
              latestExport={latestExport}
            />
          </>
        }
        main={
          <>
            {reel.status === "refused" && reel.refusal_message && (
              <p
                role="alert"
                data-testid="reel-refusal"
                className="flex-none border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                {reel.refusal_message}
              </p>
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ReelPreview reelId={reel.id} versionId={currentId} />
              <ProgressOverlay
                state={overlay}
                onTryAgain={() => void tryAgain()}
                onChangeRequest={changeRequest}
                onKeep={keepCurrent}
                actionMessage={retryForFailure?.message ?? ""}
                tryAgainBusy={retryForFailure?.busy ?? false}
              />
            </div>
          </>
        }
        footer={
          <ChangeRequestForm
            ref={changeForm}
            reelId={reel.id}
            blockedReason={blockedReason}
            queueNote={queueNote}
            jobs={jobs}
          />
        }
        versions={
          <VersionList
            reelId={reel.id}
            versions={versions}
            currentVersionId={currentId}
            blockedReason={blockedReason}
            action={
              <StartOverButton
                reelId={reel.id}
                blockedReason={blockedReason}
                queueNote={queueNote}
                jobs={jobs}
                hasVersion={currentId !== null}
              />
            }
          />
        }
        library={library}
      />
    </div>
  );
}
