// Where a word the aligner's model cannot spell is (pure; transcribe.ts runs
// it after every alignment). Such a word has no letters even in its spoken
// form (a lone symbol, a number in a language spoken-form.ts does not read),
// so the aligner leaves it the whole space between the placed words around it
// (alignedTranscript). A pause in that space would then sit inside the word's
// span, where retime never cuts. So the word is narrowed to the sound in its
// space: the largest group of envelope frames at speech level, plus a small
// margin. The rest of the space is an ordinary gap of the transcript.
import { ALIGN_SETTINGS, spokenTokens } from "./align.ts";
import { loudRuns } from "./envelope.ts";
import { EPSILON, type Run, framesWithin, length, speechThreshold } from "./speech-gaps.ts";
import type { Word } from "./transcript.ts";

type UnspelledSettings = (typeof ALIGN_SETTINGS)["unspelled"];

function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// The sound of a word inside `space`: the frames at speech level (`loud`)
// grouped over breaks of up to bridgeSeconds, the group with the most such
// frames (the first of equals), its end moved marginSeconds later, never past
// the space. Null when the space has no frame at speech level.
function soundIn(space: Run, loud: readonly Run[], settings: UnspelledSettings): Run | null {
  const groups: { run: Run; frames: number }[] = [];
  for (const run of framesWithin(loud, space, settings.envelopeFrameSeconds)) {
    const last = groups.at(-1);
    if (last && run[0] - last.run[1] <= settings.bridgeSeconds + EPSILON) {
      last.run[1] = run[1];
      last.frames += length(run);
    } else {
      groups.push({ run: [run[0], run[1]], frames: length(run) });
    }
  }
  const best = groups.reduce<(typeof groups)[number] | null>(
    (most, group) => (most && most.frames >= group.frames - EPSILON ? most : group),
    null,
  );
  if (!best) return null;
  return [best.run[0], Math.min(best.run[1] + settings.marginSeconds, space[1])];
}

// The aligned transcript with every word the model could not spell narrowed
// to its sound. The clip's speech level is measured on the spelled words
// only (the others still hold their whole space). Neighbouring unspelled
// words share one space and split its sound evenly, in order. A space with
// no sound at speech level gives each word nominalSeconds from its start
// (less when the space is shorter). A spelled word is never moved, and a
// transcript with no spelled word (Whisper's times) is returned as it is.
// Ids and texts never change.
export function placeUnspelled({
  words,
  envelope,
  language,
  settings = ALIGN_SETTINGS.unspelled,
}: {
  words: readonly Word[];
  envelope: readonly number[];
  language: string;
  settings?: UnspelledSettings;
}): Word[] {
  const spelled = spokenTokens(
    words.map((word) => word.text),
    language,
  ).map((tokens) => tokens.length > 0);
  const out = words.map((word) => ({ ...word }));
  if (!spelled.includes(true)) return out;
  const threshold = speechThreshold(
    words.filter((_, index) => spelled[index]),
    envelope,
    {
      envelopeFrameSeconds: settings.envelopeFrameSeconds,
      missedSpeechBelowSpeechDb: settings.belowSpeechDb,
      missedSpeechSeconds: 0,
    },
  );
  const loud =
    threshold === null ? [] : loudRuns(envelope, threshold, settings.envelopeFrameSeconds);
  let index = 0;
  while (index < out.length) {
    if (spelled[index]) {
      index += 1;
      continue;
    }
    let next = index;
    while (next < out.length && !spelled[next]) next += 1;
    const count = next - index;
    const space: Run = [out[index]!.start, out[next - 1]!.end];
    const [from, to] = soundIn(space, loud, settings) ?? [
      space[0],
      Math.min(space[0] + count * settings.nominalSeconds, space[1]),
    ];
    const each = Math.max(0, to - from) / count;
    for (let k = 0; k < count; k += 1) {
      const start = ms(from + k * each);
      out[index + k]!.start = start;
      out[index + k]!.end = ms(Math.max(start, from + (k + 1) * each));
    }
    index = next;
  }
  return out;
}
