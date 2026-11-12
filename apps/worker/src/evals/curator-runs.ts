import { type Transcript, bigWordSpan, transcriptSchema } from "@edit-issebya/edit";
import { answerJson, type TracedAnswer } from "../decision-trace.ts";
import type { ComponentPick, EvalWord, Span } from "./owner-marks.ts";

// THE CURATOR'S PAST RUNS: every decide answer already stored for a reel (the
// version's AI record, `<version id>.ai.json`), read back into picks. The eval
// never calls the curator: it only reads what earlier runs answered.

export interface CuratorAnswer {
  // The components prompt that answered (`reel-components@v7`).
  promptVersion: string;
  picks: ComponentPick[];
  // Picks left out: a word id the transcript does not have, or an end before its start.
  unreadable: number;
}

// The picks of one stored AI record: the last readable `decide` answer's
// accents, questions, big words and lists, as word-index spans. The hook and
// the visuals are not picks here. Null when the record holds no decide answer.
export function curatorAnswer(record: unknown, transcript: Transcript): CuratorAnswer | null {
  const fields = (record ?? {}) as { prompt_version?: unknown; calls?: unknown };
  if (!Array.isArray(fields.calls)) return null;
  const answer = (fields.calls as { role?: unknown; answerText?: unknown }[])
    .filter((call) => call?.role === "decide")
    .map((call) => answerJson(typeof call.answerText === "string" ? call.answerText : null))
    .filter((json): json is TracedAnswer => json !== null && typeof json === "object")
    .at(-1);
  if (!answer) return null;
  const index = new Map(transcript.words.map((word, at) => [word.id, at]));
  let unreadable = 0;
  const spanOf = (phrase: { from?: unknown; to?: unknown }): Span | null => {
    const from = index.get(String(phrase.from));
    const to = index.get(String(phrase.to));
    return from === undefined || to === undefined || to < from ? null : { from, to };
  };
  const picks: ComponentPick[] = [];
  const plain = (component: "accent" | "question" | "bigword", list: unknown) => {
    for (const phrase of Array.isArray(list) ? list : []) {
      const span = spanOf(component === "bigword" ? bigWordSpan(phrase) : phrase);
      if (span) picks.push({ component, span });
      else unreadable += 1;
    }
  };
  plain("accent", answer.accents);
  plain("question", answer.questions);
  plain("bigword", answer.big_words);
  for (const list of Array.isArray(answer.lists) ? answer.lists : []) {
    const items = (Array.isArray(list?.items) ? list.items : []).map(spanOf);
    if (items.length === 0 || items.some((item) => item === null)) {
      unreadable += 1;
      continue;
    }
    const spans = items as Span[];
    picks.push({
      component: "list",
      span: {
        from: Math.min(...spans.map((one) => one.from)),
        to: Math.max(...spans.map((one) => one.to)),
      },
      items: spans,
    });
  }
  return {
    promptVersion: typeof fields.prompt_version === "string" ? fields.prompt_version : "unknown",
    picks,
    unreadable,
  };
}

// What the eval reads, all of it read-only: the live AI record files
// (`stored_files`, step `decide`), the versions they belong to (for the
// transcript each was decided from) and the stored JSON objects.
export interface RunSources {
  aiFiles(): Promise<{ reelId: string; key: string }[]>;
  versions(ids: readonly string[]): Promise<VersionRow[]>;
  readJson(key: string): Promise<unknown | null>;
}

export interface VersionRow {
  id: string;
  number: number;
  // The storage key of the transcript the version was decided from.
  transcriptKey: string;
}

// One stored curator run that could belong to a dataset item: its AI record's
// key and the transcript it was decided from.
export interface RunCandidate {
  reelId: string;
  versionId: string;
  number: number;
  key: string;
  transcript: Transcript;
}

const AI_RECORD_KEY = /\/versions\/([0-9a-f-]{36})\.ai\.json$/;

// Every stored curator run of every reel, each with its transcript (a
// transcript shared by many versions is read once). A record whose version
// row or transcript is gone is left out.
export async function runCandidates(sources: RunSources): Promise<RunCandidate[]> {
  const files = (await sources.aiFiles()).flatMap((file) => {
    const versionId = AI_RECORD_KEY.exec(file.key)?.[1];
    return versionId ? [{ ...file, versionId }] : [];
  });
  const rows = new Map(
    (await sources.versions(files.map((file) => file.versionId))).map((row) => [row.id, row]),
  );
  const transcripts = new Map<string, Promise<Transcript | null>>();
  const transcriptAt = (key: string) => {
    let held = transcripts.get(key);
    if (!held) {
      held = sources.readJson(key).then((json) => {
        const parsed = transcriptSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
      });
      transcripts.set(key, held);
    }
    return held;
  };
  const out: RunCandidate[] = [];
  for (const file of files) {
    const row = rows.get(file.versionId);
    const transcript = row ? await transcriptAt(row.transcriptKey) : null;
    if (!row || !transcript) continue;
    out.push({
      reelId: file.reelId,
      versionId: file.versionId,
      number: row.number,
      key: file.key,
      transcript,
    });
  }
  return out.sort((a, b) =>
    a.reelId === b.reelId ? a.number - b.number : a.reelId < b.reelId ? -1 : 1,
  );
}

export interface CuratorRun extends CuratorAnswer {
  reelId: string;
  versionId: string;
  number: number;
  transcript: Transcript;
}

function sameWords(transcript: Transcript, words: readonly EvalWord[]): boolean {
  return (
    transcript.words.length === words.length &&
    transcript.words.every((word, at) => word.text.trim() === words[at]!.text)
  );
}

// The curator runs of one labelled reel: every stored run decided from a
// transcript whose words are the dataset item's, word for word, whatever reel
// it belongs to (a re-upload of the same footage is another reel with the
// same words). `differing` counts the runs of the labelled reel itself whose
// transcript is another one: their word positions do not fit the owner's marks.
export async function curatorRunsFor(
  item: { reelId: string; words: readonly EvalWord[] },
  candidates: readonly RunCandidate[],
  readJson: RunSources["readJson"],
): Promise<{ runs: CuratorRun[]; differing: number; unreadable: number }> {
  const runs: CuratorRun[] = [];
  let differing = 0;
  let unreadable = 0;
  for (const candidate of candidates) {
    if (!sameWords(candidate.transcript, item.words)) {
      if (candidate.reelId.startsWith(item.reelId)) differing += 1;
      continue;
    }
    const answer = curatorAnswer(await readJson(candidate.key), candidate.transcript);
    if (!answer) {
      unreadable += 1;
      continue;
    }
    runs.push({
      reelId: candidate.reelId,
      versionId: candidate.versionId,
      number: candidate.number,
      transcript: candidate.transcript,
      ...answer,
    });
  }
  return { runs, differing, unreadable };
}
