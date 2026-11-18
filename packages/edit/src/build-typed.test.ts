import { describe, expect, it } from "vitest";
import { type Layer, build } from "./build.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { soundCues } from "./sounds.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { resolveTimeline } from "./timeline.ts";
import { hookReveal } from "./reveal.ts";
import { VARIANTS } from "./variants.ts";

// Two stored versions with a hook: "Gen Z won't work like you did" over its
// whole window (0.2 s to 3 s, two lines), and "A short test for the real
// studio" cut to a 2.667 s reel's end.
const long = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const short = FIXTURES.find((fixture) => fixture.name === "baseline-short-speech-hook")!;
const plain = FIXTURES.find((fixture) => fixture.name === "rethink-work-engine")!;

async function page(fixture: typeof long, layer?: Layer) {
  return build(
    fixture.edit,
    fixture.transcript,
    fixture.headTrack,
    ISSEBYA_PRESET,
    await nodeMeasurer(),
    layer ? { layer } : {},
  );
}

const lineOf = (html: string, start: string) =>
  html
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(start))!;
const tweens = (html: string, id: string) =>
  html
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`tl.fromTo("#${id}"`) || line.startsWith(`tl.to("#${id}"`));
const audio = (html: string) =>
  html
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('<audio id="hook_k'));

describe("the typed hook on the page", () => {
  it("keeps the hook's place, size, colour, font and centred lines", async () => {
    const { html } = await page(long);
    const stored = long.edit.tracks.overlays.find((item) => item.kind === "hook")!;
    expect(stored.position).toEqual({ x: 135, y: 220, align: "left" });
    expect(lineOf(html, '<span id="hook"')).toMatch(
      /^<span id="hook" class="text hook f-artistic" style="left: 135px; top: 220px; font-size: 110px; color: #FFFFFF">/,
    );
    expect(html).toContain("      .hook { text-align: center; }");
  });

  it("holds every letter as an element of its own, in reading order, inside its word", async () => {
    const { html } = await page(long);
    const hook = lineOf(html, '<span id="hook"');
    // The carets aside ("stands a caret after every letter but the last").
    const letters = [
      ...hook
        .replace(/<i id="hook_b\d+" class="cr"><\/i>/g, "")
        .matchAll(/<span id="hook_c(\d+)" class="ch">([^<]+)<\/span>/g),
    ];
    expect(letters.map((match) => Number(match[1]))).toEqual(letters.map((_, index) => index + 1));
    expect(letters.map((match) => match[2]).join("")).toBe("GenZwon&#39;tworklikeyoudid");
    const words = [...hook.matchAll(/<span id="hook_w(\d+)" class="w">/g)];
    expect(words.map((match) => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Words joined by a space, the two lines by a line break: the text itself.
    const text = hook
      .replace(/<br \/>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&#39;/g, "'");
    expect(text).toBe("Gen Z won't\nwork like you did");
  });

  it("hides every letter until its moment, with no reflow", async () => {
    const { html } = await page(long);
    expect(html).toContain("      .ch { opacity: 0; }");
    const hook = lineOf(html, '<span id="hook"');
    // Nothing but the words, their letters with their carets, spaces and one
    // line break.
    expect(
      hook.replace(
        /<span id="hook_[cw]\d+" class="(ch|w)">|<i id="hook_b\d+" class="cr"><\/i>|<\/span>|<br \/>/g,
        "",
      ),
    ).toBe(
      '<span id="hook" class="text hook f-artistic" style="left: 135px; top: 220px; font-size: 110px; color: #FFFFFF">Gen Z won&#39;twork like you did',
    );
  });

  it("stands a caret after every letter but the last, inside its letter and out of the flow", async () => {
    const { html } = await page(long);
    expect(VARIANTS["hook/typed"].caret).toBe("bar");
    const hook = lineOf(html, '<span id="hook"');
    // Letter N holds caret N, right after its text; the last letter (23) has
    // none: the caret is gone the moment the text is fully typed.
    const carets = [
      ...hook.matchAll(
        /<span id="hook_c(\d+)" class="ch">[^<]+<i id="hook_b(\d+)" class="cr"><\/i><\/span>/g,
      ),
    ];
    expect(carets.map((match) => Number(match[2]))).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    expect(carets.every((match) => match[1] === match[2])).toBe(true);
    expect(hook).not.toContain('id="hook_b23"');
    expect(hook).toContain('<span id="hook_c23" class="ch">d</span>');
    // A thin bar in the text's colour, about a capital's height, taking no
    // room in the line; steady: nothing on the page blinks.
    expect(html).toContain("      .cr { position: absolute; margin-left: 0.04em; }");
    expect(html).toContain(
      '      .cr::before { content: ""; display: inline-block; width: 0.05em; height: 0.7em; background: currentColor; }',
    );
    expect(html).not.toMatch(/blink|@keyframes|animation/i);
  });

  it("moves the caret with each letter: a letter's caret is cut the moment the next one appears", async () => {
    const { html } = await page(long);
    const reveal = hookReveal("Gen Z won't work like you did", { start: 0.2, end: 3 });
    for (let index = 1; index < reveal.length; index += 1) {
      // Shown with its letter (it is inside it), one tween: its cut.
      expect(tweens(html, `hook_b${index}`)).toEqual([
        `tl.fromTo("#hook_b${index}", { opacity: 1 }, { opacity: 0, duration: 0.001 }, ${reveal[index]!.at});`,
      ]);
    }
    // The last caret leaves at 60% of the window, with the last letter.
    expect(tweens(html, "hook_b22")[0]).toMatch(/, 1\.88\);$/);
    expect(tweens(html, "hook_b23")).toEqual([]);
  });

  it("cuts each letter in at its own moment, the last at 60% of the hook's window", async () => {
    const { html } = await page(long);
    const reveal = hookReveal("Gen Z won't work like you did", { start: 0.2, end: 3 });
    for (const [index, letter] of reveal.entries()) {
      expect(tweens(html, `hook_c${index + 1}`)).toEqual([
        `tl.fromTo("#hook_c${index + 1}", { opacity: 0 }, { opacity: 1, duration: 0.001 }, ${letter.at});`,
      ]);
    }
    expect(tweens(html, "hook_c23")[0]).toMatch(/, 1\.88\);$/);
    expect(tweens(html, "hook_c24")).toEqual([]);
  });

  it("shows the line at its start with a cut (no rise), holds it, and leaves with the caption's fade", async () => {
    const { html } = await page(long);
    expect(tweens(html, "hook")).toEqual([
      'tl.fromTo("#hook", { opacity: 0 }, { opacity: 1, duration: 0.001 }, 0.2);',
      'tl.to("#hook", { opacity: 0, duration: 0.15 }, 2.85);',
    ]);
  });

  it("writes every cut as a 1 ms tween, never a zero-length set", async () => {
    const { html } = await page(long);
    expect(html).not.toMatch(/tl\.set\("#hook/);
    expect(html).not.toMatch(/"#hook[^"]*", \{ opacity: 0 \}, \{ opacity: 1, duration: 0 \}/);
  });

  it("types a hook cut to the reel's end over 60% of the time it has", async () => {
    const { html } = await page(short);
    // 0.2 s to 2.667 s: fully typed at 1.68 s, 26 letters on two lines.
    expect(tweens(html, "hook_c1")[0]).toMatch(/, 0\.2\);$/);
    expect(tweens(html, "hook_c26")[0]).toMatch(/, 1\.68\);$/);
    expect(tweens(html, "hook_c27")).toEqual([]);
    expect(lineOf(html, '<span id="hook"')).toContain("<br />");
  });

  it("is on the front page as on the full page, and on no other layer", async () => {
    const full = await page(long);
    const front = await page(long, "front");
    expect(lineOf(front.html, '<span id="hook"')).toBe(lineOf(full.html, '<span id="hook"'));
    expect(front.html).toContain("      .ch { opacity: 0; }");
    for (const layer of ["behind", "sound"] as const) {
      expect((await page(long, layer)).html).not.toContain('id="hook"');
    }
  });

  it("leaves a page with no hook as it was: no letter rule, no key sound", async () => {
    const { html, assets } = await page(plain);
    expect(html).not.toContain(".ch {");
    expect(html).not.toContain(".cr");
    expect(html).not.toContain("typing-key");
    expect(assets.some((asset) => asset.path.includes("typing-key"))).toBe(false);
  });

  it("builds the same page twice", async () => {
    expect(await page(long)).toEqual(await page(long));
  });
});

describe("the typing sound on the page", () => {
  it("is one audio clip per cue, in step with the letters, on the full page", async () => {
    const { html } = await page(long);
    const cues = soundCues(
      long.edit,
      resolveTimeline(long.edit, long.transcript),
      ISSEBYA_PRESET,
      long.transcript.voice,
    ).filter((cue) => cue.id.startsWith("hook_k"));
    expect(cues).toHaveLength(23);
    expect(audio(html)).toHaveLength(23);
    // This reel's transcript holds no measure of the voice: the assumed voice
    // (-20 dBFS, peaks at -3 dBFS) gives every hit the same gain.
    expect(long.transcript.voice).toBeUndefined();
    expect(audio(html)[0]).toBe(
      '<audio id="hook_k1" class="clip" src="assets/sounds/typing-key-1.wav" data-start="0.200" data-duration="0.070" data-track-index="61" data-volume="0.5827"></audio>',
    );
    // Each clip starts on the millisecond its letter appears.
    for (const [index, line] of audio(html).entries()) {
      const start = Number(/data-start="([\d.]+)"/.exec(line)![1]);
      const letter = Number(/, ([\d.]+)\);$/.exec(tweens(html, `hook_c${index + 1}`)[0]!)![1]);
      expect(start).toBe(letter);
    }
  });

  it("is on the sound page exactly as on the full page, and on no picture layer", async () => {
    const full = await page(long);
    const sound = await page(long, "sound");
    expect(audio(sound.html)).toEqual(audio(full.html));
    for (const layer of ["front", "behind"] as const) {
      expect((await page(long, layer)).html).not.toContain("<audio");
    }
  });

  it("keeps the voice and the sound track's cues as they were beside it", async () => {
    const { html } = await page(long);
    // The footage clip still carries the voice, and each cue of the sound
    // track (a visual's or a big word's: the pop) its own clip at the preset's
    // fixed gain.
    expect(html).toMatch(/<video id="[^"]+" class="clip full"[^>]*data-has-audio="true"/);
    expect(long.edit.tracks.sounds.length).toBeGreaterThan(0);
    for (const item of long.edit.tracks.sounds) {
      const clip = lineOf(html, `<audio id="${item.id}" `);
      expect(clip).toContain('src="assets/sounds/pop.wav"');
      expect(clip).toContain('data-track-index="60" data-volume="0.5012"');
    }
  });

  it("names the key sound files it plays as assets, on the full and the sound page only", async () => {
    const files = ISSEBYA_PRESET.sounds.typing.files.map((path) => ({
      path,
      role: "sound",
      ref: null,
    }));
    for (const layer of ["full", "sound"] as const) {
      const { assets } = await page(long, layer);
      expect(assets.filter((asset) => asset.path.includes("typing-key"))).toEqual(files);
    }
    for (const layer of ["front", "behind"] as const) {
      const { assets } = await page(long, layer);
      expect(assets.some((asset) => asset.role === "sound")).toBe(false);
    }
  });

  it("writes each clip's volume from the reel's measured voice, the cue's own number", async () => {
    const { html } = await page(short);
    expect(short.transcript.voice).toBeDefined();
    const cues = soundCues(
      short.edit,
      resolveTimeline(short.edit, short.transcript),
      ISSEBYA_PRESET,
      short.transcript.voice,
    );
    expect(audio(html).map((line) => /data-volume="([\d.]+)"/.exec(line)![1])).toEqual(
      cues.map((cue) => cue.volume.toFixed(4)),
    );
    // To four decimals already: the preview's gain is the very same number.
    for (const cue of cues) expect(Number(cue.volume.toFixed(4))).toBe(cue.volume);
    // A hit under a loud syllable is turned down, so not every hit is alike.
    expect(new Set(cues.map((cue) => cue.volume)).size).toBeGreaterThan(1);
  });

  it("names only the key files a short hook plays", async () => {
    const { assets, html } = await page(short);
    expect(audio(html)).toHaveLength(13);
    expect(assets.filter((asset) => asset.role === "sound")).toHaveLength(4);
  });
});
