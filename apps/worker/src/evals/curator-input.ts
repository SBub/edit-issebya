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
import type { StoredCuratorInput } from "./snapshot-format.ts";

// THE CURATOR'S INPUT for one labelled reel (app_docs/evals.md, "The curator
// eval"). Two halves:
//  - the snapshot (`snapshotCuratorInput`, run by the refresh step only): reads
//    the reel's latest stored version, its transcript, head track and edit, and
//    the written hook, and returns them as the item's `input.curator_input`;
//  - the eval (`curatorCaseOf`): rebuilds the decide step's input from that
//    stored form, with the decide step's own functions. It reads nothing else.

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

// The read sources of the snapshot: the curator runs', and the latest version of a reel.
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

// SNAPSHOT SIDE. The curator's input of a labelled reel, read from the stored
// runs and versions: the reel is the one whose stored decide run has the item's
// words (its own id first, a re-upload of the same footage otherwise). Its
// latest version gives the transcript, the head track, the edit and the hook;
// the hook falls back to the latest run's AI record when the version has none.
// Returns `skipped` with the reason when the reel cannot be rebuilt.
export async function snapshotCuratorInput({
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
}): Promise<StoredCuratorInput> {
  const skip = (reason: string): StoredCuratorInput => ({ status: "skipped", reason });
  const matching = candidates.filter((candidate) => sameWords(candidate.transcript, item.words));
  if (matching.length === 0) return skip("no stored decide run has this transcript");
  const reelId = (
    matching.find((candidate) => candidate.reelId.startsWith(item.reelId)) ?? matching[0]!
  ).reelId;
  const latest = await sources.latestVersion(reelId);
  if (!latest) return skip(`reel ${reelId} has no version`);

  const transcript = transcriptSchema.safeParse(await sources.readJson(latest.transcriptKey));
  if (!transcript.success) return skip("the latest version's transcript is unreadable");
  if (!sameWords(transcript.data, item.words)) {
    return skip("the latest version's transcript is not the dataset's words");
  }
  const head = headTrackSchema.safeParse(await sources.readJson(latest.headTrackKey));
  if (!head.success) return skip("the latest version's head track is unreadable");
  const editJson = await sources.readJson(latest.editKey);
  const parsed = parseCurrent(editJson, transcript.data);
  if (!parsed.ok) {
    return skip(`the latest version does not parse: ${parsed.reasons[0] ?? "unknown"}`);
  }

  // The latest stored run of the reel: the fallback hook and the stored values to compare.
  const latestRun = candidates
    .filter((candidate) => candidate.reelId === reelId)
    .sort((a, b) => b.number - a.number)[0];
  const stored = latestRun ? storedOf(await sources.readJson(latestRun.key), preset) : {};

  const versionHook = parsed.edit.tracks.overlays
    .find((overlay) => overlay.kind === "hook")
    ?.text?.trim();
  let hook: { text: string; source: "version" | "ai record" };
  if (versionHook) {
    hook = { text: versionHook, source: "version" };
  } else if (stored.hook) {
    hook = { text: stored.hook, source: "ai record" };
  } else {
    return skip("no hook in the latest version or its latest run");
  }

  return {
    status: "ready",
    reel_id: reelId,
    version_id: latest.id,
    version_number: latest.number,
    preset: preset.id,
    transcript: transcript.data,
    head_track: head.data,
    edit: editJson,
    hook,
    stored_run: {
      ...(stored.intensity !== undefined ? { intensity: stored.intensity } : {}),
      ...(stored.target_picks !== undefined ? { target_picks: stored.target_picks } : {}),
    },
  };
}

// EVAL SIDE. The case of one labelled reel from its snapshot: the edit parsed
// over the snapshot's transcript, the intensity and the target from the decide
// step's `decideInput` with the preset, and the stored run's values compared
// (a difference is noted, never used). Reads nothing outside the item.
export function curatorCaseOf({
  item,
  stored,
  preset,
  parseCurrent = (json, transcript) => parseEdit(json, preset, transcript),
}: {
  item: OwnerItem;
  stored: StoredCuratorInput;
  preset: Preset;
  parseCurrent?: ParseCurrent;
}): CuratorBuild {
  if (stored.status === "skipped") return { ok: false, reason: stored.reason };
  if (stored.preset !== preset.id) {
    return {
      ok: false,
      reason: `the snapshot was taken with preset ${stored.preset}, not ${preset.id}`,
    };
  }
  const parsed = parseCurrent(stored.edit, stored.transcript);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `the snapshot's edit does not parse: ${parsed.reasons[0] ?? "unknown"}`,
    };
  }
  const notes: string[] = [];
  if (stored.hook.source === "ai record") {
    notes.push("the latest version has no hook: the hook is the latest run's AI record");
  }
  const input = decideInput({
    transcript: stored.transcript,
    preset,
    hook: { text: stored.hook.text },
  });
  const ran = stored.stored_run;
  if (ran.intensity !== undefined && ran.intensity !== input.intensity) {
    notes.push(`stored intensity ${ran.intensity} differs from ${input.intensity}`);
  }
  if (ran.target_picks !== undefined && ran.target_picks !== input.target_picks) {
    notes.push(`stored target ${ran.target_picks} differs from ${input.target_picks}`);
  }
  return {
    ok: true,
    case: {
      item,
      reelId: stored.reel_id,
      versionId: stored.version_id,
      versionNumber: stored.version_number,
      transcript: stored.transcript,
      current: parsed.edit,
      headTrack: stored.head_track,
      hook: stored.hook,
      input,
      notes,
    },
  };
}
