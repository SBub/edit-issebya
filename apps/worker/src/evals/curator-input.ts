import {
  type Edit,
  type HeadTrack,
  type Preset,
  type Transcript,
  headTrackSchema,
  parseEdit,
  parseHookAnswer,
  transcriptSchema,
} from "@edit-issebya/edit";
import { type DecideInput, decideInput } from "../decide/input.ts";
import { answerJson } from "../decision-trace.ts";
import type { OwnerItem } from "./owner-marks.ts";
import { type RunCandidate, type RunSources, sameWords } from "./curator-runs.ts";

// THE CURATOR'S INPUT for one labelled reel (app_docs/evals.md, "The curator
// eval"): exactly what the decide step gives the components call, rebuilt from
// the reel's latest stored version. Read-only: the version, its transcript and
// head track are read from storage, nothing is written.

// The latest stored version of a reel and the storage keys of what it reads.
export interface LatestVersion {
  id: string;
  number: number;
  // The version's edit JSON (its R2 key).
  editKey: string;
  // The transcript and head track the version was decided from.
  transcriptKey: string;
  headTrackKey: string;
}

// The read sources of the curator eval: the judge eval's, and the latest version of a reel.
export interface CuratorSources extends RunSources {
  latestVersion(reelId: string): Promise<LatestVersion | null>;
}

// The parsed edit of the latest version (the decide step's `parseEdit`).
export type ParseCurrent = (
  json: unknown,
  transcript: Transcript,
) => { ok: true; edit: Edit } | { ok: false; reasons: string[] };

export interface CuratorCase {
  item: OwnerItem;
  reelId: string;
  versionId: string;
  versionNumber: number;
  transcript: Transcript;
  // The latest version as the decide step would read it: the base the answer is placed over.
  current: Edit;
  headTrack: HeadTrack;
  // The written hook the components call sees (the version's, else the run's).
  hook: { text: string; source: "version" | "ai record" };
  input: DecideInput;
  // Stored values that differ from the reproduced ones, and what was read instead.
  notes: string[];
}

export type CuratorBuild = { ok: true; case: CuratorCase } | { ok: false; reason: string };

// The stored values of a run's AI record the input is checked against.
interface StoredRun {
  intensity?: string;
  target_picks?: number;
  hook?: string;
}

function storedOf(record: unknown, preset: Preset): StoredRun {
  const fields = (record ?? {}) as {
    intensity?: unknown;
    target_picks?: unknown;
    calls?: unknown;
  };
  const hookCall = (Array.isArray(fields.calls) ? fields.calls : []).find(
    (call): call is { role: string; answerText: string } =>
      typeof call === "object" &&
      call !== null &&
      (call as { role?: unknown }).role === "hook" &&
      typeof (call as { answerText?: unknown }).answerText === "string",
  );
  // The hook as the decide step placed it (`parseHookAnswer`: its final stop taken off).
  const hookJson = hookCall ? answerJson(hookCall.answerText) : null;
  const hook = hookJson === null ? null : parseHookAnswer(hookJson, preset);
  const hookText = hook?.ok ? hook.text : undefined;
  return {
    ...(typeof fields.intensity === "string" ? { intensity: fields.intensity } : {}),
    ...(typeof fields.target_picks === "number" ? { target_picks: fields.target_picks } : {}),
    ...(hookText ? { hook: hookText } : {}),
  };
}

// The case of one labelled reel. The reel is the one whose stored decide run
// has the item's words (its own id first, a re-upload of the same footage
// otherwise). Its latest version gives the transcript, the head track, the
// edit (its hook); the hook falls back to the latest run's AI record when the
// version has none. The intensity and the target are computed by the decide
// step's own functions (`decideInput`) with the preset; the latest run's
// stored values are compared and any difference is noted.
export async function buildCuratorCase({
  item,
  candidates,
  sources,
  preset,
  parseCurrent = (json, transcript) => parseEdit(json, preset, transcript),
}: {
  item: OwnerItem;
  candidates: readonly RunCandidate[];
  sources: CuratorSources;
  preset: Preset;
  parseCurrent?: ParseCurrent;
}): Promise<CuratorBuild> {
  const matching = candidates.filter((candidate) => sameWords(candidate.transcript, item.words));
  if (matching.length === 0) {
    return { ok: false, reason: "no stored decide run has this transcript" };
  }
  const reelId = (
    matching.find((candidate) => candidate.reelId.startsWith(item.reelId)) ?? matching[0]!
  ).reelId;
  const latest = await sources.latestVersion(reelId);
  if (!latest) return { ok: false, reason: `reel ${reelId} has no version` };

  const transcript = transcriptSchema.safeParse(await sources.readJson(latest.transcriptKey));
  if (!transcript.success)
    return { ok: false, reason: "the latest version's transcript is unreadable" };
  if (!sameWords(transcript.data, item.words)) {
    return { ok: false, reason: "the latest version's transcript is not the dataset's words" };
  }
  const head = headTrackSchema.safeParse(await sources.readJson(latest.headTrackKey));
  if (!head.success) return { ok: false, reason: "the latest version's head track is unreadable" };
  const parsed = parseCurrent(await sources.readJson(latest.editKey), transcript.data);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `the latest version does not parse: ${parsed.reasons[0] ?? "unknown"}`,
    };
  }

  // The latest stored run of the reel: the fallback hook and the stored values to compare.
  const latestRun = candidates
    .filter((candidate) => candidate.reelId === reelId)
    .sort((a, b) => b.number - a.number)[0];
  const stored = latestRun ? storedOf(await sources.readJson(latestRun.key), preset) : {};

  const versionHook = parsed.edit.tracks.overlays
    .find((overlay) => overlay.kind === "hook")
    ?.text?.trim();
  const notes: string[] = [];
  let hook: CuratorCase["hook"];
  if (versionHook) {
    hook = { text: versionHook, source: "version" };
  } else if (stored.hook) {
    hook = { text: stored.hook, source: "ai record" };
    notes.push("the latest version has no hook: the hook is the latest run's AI record");
  } else {
    return { ok: false, reason: "no hook in the latest version or its latest run" };
  }

  const input = decideInput({ transcript: transcript.data, preset, hook: { text: hook.text } });
  if (stored.intensity !== undefined && stored.intensity !== input.intensity) {
    notes.push(`stored intensity ${stored.intensity} differs from ${input.intensity}`);
  }
  if (stored.target_picks !== undefined && stored.target_picks !== input.target_picks) {
    notes.push(`stored target ${stored.target_picks} differs from ${input.target_picks}`);
  }
  return {
    ok: true,
    case: {
      item,
      reelId,
      versionId: latest.id,
      versionNumber: latest.number,
      transcript: transcript.data,
      current: parsed.edit,
      headTrack: head.data,
      hook,
      input,
      notes,
    },
  };
}
