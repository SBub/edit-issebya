import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ISSEBYA_PRESET } from "./preset.ts";
import { hookReveal } from "./reveal.ts";
import {
  ASSUMED_VOICE,
  soundCues,
  soundFiles,
  typingCues,
  typingGain,
  voiceLevel,
} from "./sounds.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Voice } from "./transcript.ts";
import { VARIANTS } from "./variants.ts";

const TYPING = ISSEBYA_PRESET.sounds[VARIANTS["hook/typed"].sound];
const LEVEL = VARIANTS["hook/typed"].soundLevel;
const WINDOW = { start: 0.2, end: 3 };

const cuesOf = (text: string, span = WINDOW, reelEnd = 50, voice?: Voice) =>
  typingCues("hook", hookReveal(text, span), TYPING, LEVEL, voice, reelEnd);

// A voice of 5 s: every 0.1 s window at `level` with its peak at `peak`
// (dBFS), but for the windows named in `other`.
function voiceOf(level: number, peak: number, other: Record<number, [number, number]> = {}): Voice {
  const windows = Array.from({ length: 50 }, (_, index) => other[index] ?? [level, peak]);
  return {
    windowSeconds: 0.1,
    levels: windows.map((window) => window[0]!),
    peaks: windows.map((window) => window[1]!),
  };
}

const db = (gain: number) => 20 * Math.log10(gain);
const linear = (value: number) => 10 ** (value / 20);
// The typing span of a hook on the whole window: 0.2 s to 1.88 s plus a hit.
const TYPED = { start: 0.2, end: 1.95 };

const fixture = (name: string) => FIXTURES.find((entry) => entry.name === name)!;

describe("the typing sound's cues", () => {
  it("hit on every letter of a hook typed slowly enough, at the letter's own moment", () => {
    const reveal = hookReveal("Gen Z won't work like you did", WINDOW);
    const cues = cuesOf("Gen Z won't work like you did");
    // 23 letters over 1.68 s: 76 ms apart, more than the sound's gap.
    expect(cues.map((cue) => cue.at)).toEqual(reveal.map((letter) => letter.at));
    expect(cues[0]).toEqual({
      id: "hook_k1",
      file: "assets/sounds/typing-key-1.wav",
      at: 0.2,
      duration: 0.07,
      // No measure of the voice: the assumed voice's gain.
      volume: 0.5827,
      track: 61,
    });
  });

  it("hit on every second letter of a long hook, so two hits keep the sound's gap", () => {
    const text = "Nobody tells you this about your first hires!";
    const reveal = hookReveal(text, WINDOW);
    const cues = cuesOf(text);
    // 38 letters over 1.68 s: 45 ms apart, under the 70 ms gap.
    expect(cues).toHaveLength(19);
    expect(cues.map((cue) => cue.at)).toEqual(
      reveal.filter((_, index) => index % 2 === 0).map((letter) => letter.at),
    );
    for (const [index, cue] of cues.entries()) {
      if (index > 0)
        expect(cue.at - cues[index - 1]!.at).toBeGreaterThanOrEqual(TYPING.minGapSeconds);
    }
  });

  it("always land on a letter's moment and never after the typing ends", () => {
    for (const text of ["Stop", "Why?", "A short test for the real studio", "x".repeat(45)]) {
      const reveal = hookReveal(text, WINDOW);
      const moments = new Set(reveal.map((letter) => letter.at));
      const cues = cuesOf(text);
      expect(cues.length).toBeGreaterThan(0);
      expect(cues[0]!.at).toBe(0.2);
      for (const cue of cues) {
        expect(moments.has(cue.at)).toBe(true);
        expect(cue.at).toBeLessThanOrEqual(1.88);
      }
    }
  });

  it("never play one hit over the next: a hit ends where the next one starts", () => {
    for (const text of ["Gen Z won't work like you did", "x".repeat(45), "x".repeat(31)]) {
      for (const span of [WINDOW, { start: 0, end: 0.5 }, { start: 0.2, end: 2.667 }]) {
        const cues = cuesOf(text, span);
        for (const [index, cue] of cues.entries()) {
          expect(cue.duration).toBeGreaterThan(0);
          expect(cue.duration).toBeLessThanOrEqual(TYPING.durationSeconds);
          const next = cues[index + 1];
          if (next) expect(cue.at + cue.duration).toBeLessThanOrEqual(next.at + 1e-9);
        }
      }
    }
  });

  it("play the key files in turn, so two hits in a row never sound the same", () => {
    const cues = cuesOf("Gen Z won't work like you did");
    expect(cues.slice(0, 5).map((cue) => cue.file)).toEqual([
      TYPING.files[0],
      TYPING.files[1],
      TYPING.files[2],
      TYPING.files[3],
      TYPING.files[0],
    ]);
    for (const [index, cue] of cues.entries()) {
      if (index > 0) expect(cue.file).not.toBe(cues[index - 1]!.file);
    }
  });

  it("play 8 dB under the voice by default, each hit at the gain of its own moment", () => {
    expect(LEVEL).toBe(-8);
    const voice = voiceOf(-20, -6, { 7: [-20, -1] });
    const gain = typingGain(TYPING, LEVEL, voice, { start: 0.2, end: 1.95 });
    const cues = cuesOf("Stop", WINDOW, 50, voice);
    expect(cues.map((cue) => cue.at)).toEqual([0.2, 0.76, 1.32, 1.88]);
    expect(cues.map((cue) => cue.volume)).toEqual(cues.map((cue) => gain(cue.at, cue.duration)));
    // The hit at 0.76 s plays under the loud window (0.7 to 0.8 s): turned down.
    expect(cues[1]!.volume).toBeLessThan(cues[0]!.volume);
    expect(cues[2]!.volume).toBe(cues[0]!.volume);
  });

  it("are cut at the reel's end, and left out with no time left", () => {
    // The reel ends 30 ms after the last letter's hit.
    const cues = cuesOf("Stop", WINDOW, 1.91);
    expect(cues.at(-1)).toMatchObject({ at: 1.88, duration: 0.03 });
    expect(cuesOf("Stop", WINDOW, 1.88).map((cue) => cue.at)).toEqual([0.2, 0.76, 1.32]);
  });

  it("are one hit for a text of one letter, and none for no text", () => {
    expect(cuesOf("?")).toHaveLength(1);
    expect(cuesOf("")).toEqual([]);
    // A span of no length: every letter at one moment, one hit.
    expect(cuesOf("Stop", { start: 1, end: 1 })).toHaveLength(1);
  });
});

describe("the sound files", () => {
  // A 16-bit PCM WAV file, its samples -1 to 1: `mono` the mix of its channels
  // (what a level is measured on), `peak` the highest sample of any channel.
  function wave(file: string): { mono: number[]; peak: number } {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's own assets
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    const channels = bytes.readUInt16LE(bytes.indexOf("fmt ", 12, "latin1") + 10);
    const data = bytes.indexOf("data", 12, "latin1");
    const length = bytes.readUInt32LE(data + 4);
    const mono: number[] = [];
    let peak = 0;
    for (let at = data + 8; at < data + 8 + length; at += 2 * channels) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) {
        const sample = bytes.readInt16LE(at + 2 * channel) / 32768;
        peak = Math.max(peak, Math.abs(sample));
        sum += sample;
      }
      mono.push(sum / channels);
    }
    return { mono, peak };
  }

  // Every sound of the preset, the key sound's four takes as one sound.
  it.each(Object.entries(ISSEBYA_PRESET.sounds))(
    "%s is as loud as the preset says: the level and the peak a gain is worked out from",
    (name, sound) => {
      const files = sound.files.map(wave);
      const powers = files.map(
        (file) => file.mono.reduce((sum, x) => sum + x * x, 0) / file.mono.length,
      );
      const level = 10 * Math.log10(powers.reduce((sum, x) => sum + x, 0) / powers.length);
      const peak = db(Math.max(...files.map((file) => file.peak)));
      console.log(`${name}: level ${level.toFixed(2)} dBFS, peak ${peak.toFixed(2)} dBFS`);
      expect(Math.abs(level - sound.level)).toBeLessThanOrEqual(0.05);
      // The preset's peak is never under the real one, so a ceiling holds.
      expect(sound.peak).toBeGreaterThanOrEqual(peak);
      expect(sound.peak - peak).toBeLessThanOrEqual(0.05);
      // Each file lasts the preset's length.
      for (const file of files) {
        expect(file.mono.length / 44100).toBeCloseTo(sound.durationSeconds, 3);
      }
    },
  );
});

describe("the voice a sound is set against", () => {
  it("is the level and the peak of the span it is asked for", () => {
    const voice = voiceOf(-30, -18, { 3: [-20, -6], 4: [-20, -7], 5: [-20, -8], 6: [-20, -9] });
    expect(voiceLevel(voice, { start: 0.3, end: 0.7 })).toEqual({
      level: expect.closeTo(-20, 6),
      peak: -6,
      from: "span",
    });
    expect(voiceLevel(voice, { start: 2, end: 3 })).toEqual({
      level: expect.closeTo(-30, 6),
      peak: -18,
      from: "span",
    });
  });

  it("leaves the pauses out: a window 10 dB under the others, or under -50 dBFS", () => {
    const pauses = Object.fromEntries(
      [3, 5, 7, 9, 11].map((index) => [index, [index === 5 ? -70 : -45, -30]]),
    ) as Record<number, [number, number]>;
    const level = voiceLevel(voiceOf(-20, -6, pauses), TYPED);
    expect(level.level).toBeCloseTo(-20, 6);
    expect(level.from).toBe("span");
  });

  it("is the whole reel's voice when the span holds under 0.3 s of voice", () => {
    // Silence until 2 s, but for two windows of voice: 0.2 s, too little.
    const quiet = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        index,
        index === 5 || index === 6 ? [-35, -22] : [-70, -60],
      ]),
    ) as Record<number, [number, number]>;
    expect(voiceLevel(voiceOf(-18, -4, quiet), TYPED)).toEqual({
      level: expect.closeTo(-18, 6),
      peak: -4,
      from: "reel",
    });
  });

  it("is the assumed voice with no measure, and for a reel with no voice at all", () => {
    expect(ASSUMED_VOICE).toEqual({ level: -20, peak: -3, from: "assumed" });
    expect(voiceLevel(undefined, TYPED)).toBe(ASSUMED_VOICE);
    expect(voiceLevel(voiceOf(-80, -70), TYPED)).toBe(ASSUMED_VOICE);
  });

  it("reads a span past the measure's end as the reel's", () => {
    expect(voiceLevel(voiceOf(-20, -6), { start: 9, end: 10 }).from).toBe("reel");
  });
});

describe("the typing's gain", () => {
  // What a hit at this gain measures: its own level and peak, in dBFS.
  const hit = (gain: number) => ({ level: db(gain) + TYPING.level, peak: db(gain) + TYPING.peak });
  const gainOver = (voice: Voice | undefined, soundLevel = -8) =>
    typingGain(TYPING, soundLevel, voice, TYPED);

  it("puts a hit `soundLevel` dB under the voice's level", () => {
    const gain = gainOver(voiceOf(-20, -6))(0.5, 0.07);
    expect(hit(gain).level).toBeCloseTo(-28, 1);
    expect(hit(gainOver(voiceOf(-20, -6), -12)(0.5, 0.07)).level).toBeCloseTo(-32, 1);
  });

  it("follows the voice: a quiet voice gets quiet keys, a louder one louder keys", () => {
    const quiet = gainOver(voiceOf(-38, -24))(0.5, 0.07);
    const usual = gainOver(voiceOf(-26, -12))(0.5, 0.07);
    expect(hit(quiet).level).toBeCloseTo(-46, 1);
    expect(hit(usual).level).toBeCloseTo(-34, 1);
    // 12 dB between the voices, 12 dB between the keys.
    expect(db(usual) - db(quiet)).toBeCloseTo(12, 1);
  });

  it("never lets a hit peak over the voice's peak", () => {
    // A voice with little between its level and its peaks: -8 dB would put
    // the hit's peak (20 dB over its level) above the voice's.
    const gain = gainOver(voiceOf(-20, -12))(0.5, 0.07);
    expect(hit(gain).peak).toBeLessThanOrEqual(-12);
    expect(hit(gain).peak).toBeCloseTo(-12, 1);
    expect(hit(gain).level).toBeLessThan(-28);
    // Asking for more changes nothing: the ceiling holds.
    expect(gainOver(voiceOf(-20, -12), 0)(0.5, 0.07)).toBe(gain);
  });

  it("never lets a hit and the voice add up to more than full scale, hit by hit", () => {
    // A loud voice, peaks at -2 dBFS, one syllable at -0.5 dBFS (0.7 to 0.8 s).
    const voice = voiceOf(-14, -2, { 7: [-10, -0.5] });
    const gain = gainOver(voice);
    for (const at of [0.2, 0.5, 0.69, 0.75, 0.79, 0.9, 1.88]) {
      const windows = [Math.floor(at * 10 + 1e-9), Math.floor((at + 0.07) * 10 - 1e-9)];
      const under = Math.max(...windows.map((index) => voice.peaks[index]!));
      expect(linear(under) + gain(at, 0.07) * linear(TYPING.peak)).toBeLessThanOrEqual(1);
    }
    // The hit under the loud syllable is turned down, also one that only
    // runs into it; the others are not.
    expect(gain(0.75, 0.07)).toBeLessThan(gain(0.5, 0.07));
    expect(gain(0.69, 0.07)).toBe(gain(0.75, 0.07));
    expect(gain(0.9, 0.07)).toBe(gain(0.5, 0.07));
    // Under this loud a voice every hit is at the room its moment leaves:
    // full scale less the voice's peak, here 0.2057 of full scale.
    expect(gain(0.5, 0.07)).toBe(
      Math.floor(((1 - linear(-2)) / linear(TYPING.peak)) * 10000) / 10000,
    );
    expect(db(gain(0.5, 0.07)) + TYPING.level).toBeLessThan(-14 - 8);
  });

  it("is silent under a voice already at full scale", () => {
    const gain = gainOver(voiceOf(-14, -3, { 7: [-6, 0], 8: [-6, 0.4] }));
    expect(gain(0.75, 0.07)).toBe(0);
    expect(gain(0.85, 0.07)).toBe(0);
    expect(gain(0.5, 0.07)).toBeGreaterThan(0);
  });

  it("takes the reel's voice for a hook typed over silence", () => {
    const silent = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [index, [-70, -60]]),
    ) as Record<number, [number, number]>;
    const gain = gainOver(voiceOf(-20, -6, silent))(0.5, 0.07);
    // 8 dB under the reel's voice, with all the room of a silent moment.
    expect(hit(gain).level).toBeCloseTo(-28, 1);
  });

  it("is one fixed gain with no measure: the assumed voice's, under its ceilings", () => {
    const gain = gainOver(undefined);
    expect(gain(0.2, 0.07)).toBe(0.5827);
    expect(gain(1.88, 0.07)).toBe(0.5827);
    expect(linear(ASSUMED_VOICE.peak) + 0.5827 * linear(TYPING.peak)).toBeLessThanOrEqual(1);
  });

  it("is written to four decimals, rounded down", () => {
    for (const level of [-31.3, -20, -17.7]) {
      const gain = gainOver(voiceOf(level, level + 13))(0.5, 0.07);
      expect(Number(gain.toFixed(4))).toBe(gain);
    }
  });
});

describe("a version's sound cues", () => {
  it("are the hook's key sounds for a version with a hook and no sound track", () => {
    const { edit, transcript } = fixture("baseline-short-speech-hook");
    const cues = soundCues(
      edit,
      resolveTimeline(edit, transcript),
      ISSEBYA_PRESET,
      transcript.voice,
    );
    // The hook is cut to the reel's end (2.667 s): typed until 1.68 s, 26
    // letters 59 ms apart, so a hit on every second one.
    expect(cues).toHaveLength(13);
    expect(cues.map((cue) => cue.id)).toEqual(cues.map((_, index) => `hook_k${index + 1}`));
    expect(cues[0]!.at).toBe(0.2);
    expect(cues.at(-1)!.at).toBeLessThanOrEqual(1.68);
    // The fixture clip's transcript holds its measured voice: the hits are set
    // against it, each under its own moment's ceiling.
    const gain = typingGain(TYPING, LEVEL, transcript.voice, { start: 0.2, end: 1.691 });
    expect(voiceLevel(transcript.voice, { start: 0.2, end: 1.691 }).from).toBe("span");
    expect(cues.map((cue) => cue.volume)).toEqual(cues.map((cue) => gain(cue.at, cue.duration)));
  });

  it("are the sound track's items, a behind item's cue playing the pop, for a version with no hook", () => {
    const { edit, transcript } = fixture("rethink-work-engine");
    const resolved = resolveTimeline(edit, transcript);
    const cues = soundCues(edit, resolved, ISSEBYA_PRESET, transcript.voice);
    expect(edit.tracks.sounds.length).toBeGreaterThan(0);
    // The track stores `click`; each is the cue of a visual or a big word, so
    // it plays the pop (`cueSound`) at the preset's fixed gain.
    expect(edit.tracks.sounds.map((item) => item.sound)).toEqual(
      edit.tracks.sounds.map(() => "click"),
    );
    const { pop } = ISSEBYA_PRESET.sounds;
    expect(cues).toEqual(
      edit.tracks.sounds.map((item) => ({
        id: item.id,
        file: "assets/sounds/pop.wav",
        at: resolved.get(item.id)!.start,
        duration: pop.durationSeconds,
        volume: 10 ** (pop.gainDb / 20),
        track: 60,
      })),
    );
  });

  it("plays any other item of the sound track as the sound it names, its first file", () => {
    const { edit, transcript } = fixture("rethink-work-engine");
    const [first] = edit.tracks.sounds;
    const own = {
      ...edit,
      tracks: { ...edit.tracks, sounds: [{ ...first!, id: "s-own", gain_db: -12 }] },
    };
    const [cue] = soundCues(own, resolveTimeline(own, transcript), ISSEBYA_PRESET, undefined);
    expect(cue).toMatchObject({
      id: "s-own",
      file: "assets/sounds/mouse-click-trimmed.wav",
      volume: 10 ** (-12 / 20),
      track: 60,
    });
  });

  it("put the clicks first and the key sounds on a track of their own", () => {
    const { edit, transcript } = fixture("rethink-work-hook");
    const cues = soundCues(
      edit,
      resolveTimeline(edit, transcript),
      ISSEBYA_PRESET,
      transcript.voice,
    );
    const clicks = cues.filter((cue) => cue.track === 60);
    const keys = cues.filter((cue) => cue.track === 61);
    expect(clicks.map((cue) => cue.id)).toEqual(edit.tracks.sounds.map((item) => item.id));
    expect(keys).toHaveLength(23);
    expect(cues).toEqual([...clicks, ...keys]);
    expect(new Set(cues.map((cue) => cue.id)).size).toBe(cues.length);
  });

  it("names every sound file, each take of the key sound too, for whoever serves the assets", () => {
    expect(soundFiles(ISSEBYA_PRESET)).toEqual([
      "assets/sounds/mouse-click-trimmed.wav",
      "assets/sounds/camera-shutter.wav",
      "assets/sounds/whoosh.wav",
      "assets/sounds/pop.wav",
      ...TYPING.files,
    ]);
    expect(TYPING.files).toHaveLength(4);
  });
});
