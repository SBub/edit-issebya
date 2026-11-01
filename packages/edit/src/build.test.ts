import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "./build.ts";
import type { Measurer } from "./measure.ts";
import { ISSEBYA } from "./preset.ts";
import type { Transcript } from "./transcript.ts";
import { BUILT, type Fixture, fixtures, nodeMeasurer, rethinkWork } from "./testdata/node.ts";

let measurer: Measurer;
let all: Fixture[];

beforeAll(async () => {
  measurer = await nodeMeasurer();
  all = await fixtures();
});

const layoutText = (layout: unknown) => `${JSON.stringify(layout, null, 2)}\n`;

describe("build goldens", () => {
  it("builds each fixture version to exactly its golden html and layout", async () => {
    for (const fixture of all) {
      const { html, layout } = build({ ...fixture, preset: ISSEBYA, measurer });
      const htmlPath = join(BUILT, `${fixture.name}.html`);
      const layoutPath = join(BUILT, `${fixture.name}.layout.json`);
      if (process.env.UPDATE_GOLDEN === "1") {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's golden folder
        await mkdir(BUILT, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's golden folder
        await writeFile(htmlPath, html);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's golden folder
        await writeFile(layoutPath, layoutText(layout));
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's golden folder
      expect(html, fixture.name).toBe(await readFile(htmlPath, "utf8"));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's golden folder
      expect(layoutText(layout), fixture.name).toBe(await readFile(layoutPath, "utf8"));
    }
  });

  it("gives byte-identical output twice", () => {
    for (const fixture of all) {
      const first = build({ ...fixture, preset: ISSEBYA, measurer });
      const second = build({ ...fixture, preset: ISSEBYA, measurer });
      expect(second.html).toBe(first.html);
      expect(second.layout).toEqual(first.layout);
      expect(second.assets).toEqual(first.assets);
    }
  });

  it("lists the assets the page references, with the input fingerprints", () => {
    const fixture = all.find((entry) => entry.name === "rethink-work-accents")!;
    const { html, assets } = build({ ...fixture, preset: ISSEBYA, measurer });
    expect(assets).toEqual([
      { role: "font", path: "assets/fonts/GolosText-Bold.ttf" },
      { role: "font", path: "assets/fonts/Raleway-Light.ttf" },
      { role: "sound", path: "assets/sounds/mouse-click-trimmed.wav" },
      { role: "footage", path: "footage.mp4", fingerprint: "1".repeat(64) },
      { role: "cutout", path: "subject.webm", fingerprint: "3".repeat(64) },
    ]);
    for (const asset of assets) expect(html).toContain(`"${asset.path}"`);
    // -13 dB.
    expect(html).toContain('data-volume="0.224"');
    expect(html).toContain('window.__timelines["main"] = tl;');
  });

  it("escapes text and keeps a custom style inside the attribute", () => {
    const fixture = all.find((entry) => entry.name === "short-speech-baseline")!;
    const transcript: Transcript = {
      words: fixture.transcript.words.map((word, index) =>
        index === 0 ? { ...word, text: `<b>"Tom" & 'Jerry'</b>` } : word,
      ),
    };
    const edit = structuredClone(fixture.edit) as {
      tracks: { captions: Record<string, unknown>[] };
    };
    edit.tracks.captions[0] = {
      ...edit.tracks.captions[0],
      text: `<b>"Tom" & 'Jerry'</b>`,
      custom: "letter-spacing: 2px",
    };
    const { html } = build({ ...fixture, edit, transcript, preset: ISSEBYA, measurer });
    expect(html).toContain("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
    expect(html).toMatch(/style="[^"]*;letter-spacing: 2px"/);
  });

  it("throws on an invalid edit", () => {
    const fixture = all[0]!;
    expect(() => build({ ...fixture, edit: { format: 2 }, preset: ISSEBYA, measurer })).toThrow();
  });
});

describe("anchors survive a retime", () => {
  type Point = { word?: string; edge?: "start" | "end"; offset?: number; at?: number };
  type StoredItem = { id: string; start: Point; end: Point };

  it("moves every item with its word", () => {
    const shift = (t: number) => Math.round((t * 1.1 + 0.5) * 1000) / 1000;
    for (const fixture of all) {
      const retimed: Transcript = {
        words: fixture.transcript.words.map((word) => ({
          ...word,
          start: shift(word.start),
          end: shift(word.end),
        })),
      };
      const words = new Map(retimed.words.map((word) => [word.id, word]));
      const expected = (point: Point, edge: "start" | "end") => {
        if (point.at !== undefined) return point.at;
        const word = words.get(point.word!)!;
        const time = (point.edge ?? edge) === "start" ? word.start : word.end;
        return Math.round((time + (point.offset ?? 0)) * 1000) / 1000;
      };
      const tracks = (fixture.edit as { tracks: Record<string, StoredItem[]> }).tracks;
      const items = new Map(
        Object.values(tracks)
          .flat()
          .map((item) => [item.id, item]),
      );
      const before = build({ ...fixture, preset: ISSEBYA, measurer });
      const after = build({ ...fixture, transcript: retimed, preset: ISSEBYA, measurer });
      expect(after.layout.map((entry) => entry.id).sort()).toEqual(
        before.layout.map((entry) => entry.id).sort(),
      );
      for (const entry of after.layout) {
        const item = items.get(entry.id)!;
        const start = expected(item.start, "start");
        expect(entry.start, entry.id).toBe(start);
        expect(entry.end, entry.id).toBe(expected(item.end, "end"));
        if (entry.track === "transitions") {
          expect(after.html).toContain(
            `id="${entry.id}" class="clip t-dim" data-start="${start.toFixed(3)}"`,
          );
        } else {
          expect(after.html).toContain(
            `tl.fromTo("#${entry.id}", {opacity: 0, y: 12}, {opacity: 1, y: 0, duration: 0.180, ease: "power2.out"}, ${start.toFixed(3)});`,
          );
        }
      }
      for (const sound of tracks.sounds ?? []) {
        expect(after.html).toContain(
          `<audio id="${sound.id}" class="clip" src="assets/sounds/mouse-click-trimmed.wav" data-start="${expected(sound.start, "start").toFixed(3)}"`,
        );
      }
    }
  });
});

describe("speed", () => {
  it("builds the rethink-work baseline in under 200 ms", async () => {
    const { transcript, headTrack } = await rethinkWork();
    const edit = all.find((entry) => entry.name === "rethink-work-baseline")!.edit;
    let best = Infinity;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      build({ edit, transcript, headTrack, preset: ISSEBYA, measurer });
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(200);
  });
});
