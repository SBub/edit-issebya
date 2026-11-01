import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ISSEBYA } from "./preset.ts";
import { soundHits } from "./sounds.ts";
import { BUILT, type Fixture, fixtures } from "./testdata/node.ts";

let all: Fixture[];

beforeAll(async () => {
  all = await fixtures();
});

describe("soundHits", () => {
  it("agrees with every <audio> line of the golden page", async () => {
    const fixture = all.find((entry) => entry.name === "rethink-work-accents")!;
    const hits = soundHits(fixture.edit, fixture.transcript, ISSEBYA);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the package's golden folder
    const html = await readFile(join(BUILT, `${fixture.name}.html`), "utf8");
    const lines = [
      ...html.matchAll(
        /<audio id="([^"]+)" class="clip" src="([^"]+)" data-start="([^"]+)" data-duration="([^"]+)"[^>]* data-volume="([^"]+)"/g,
      ),
    ];
    expect(lines.length).toBeGreaterThan(0);
    expect(
      hits.map((hit) => [
        hit.id,
        hit.path,
        hit.at.toFixed(3),
        hit.duration.toFixed(3),
        hit.gain.toFixed(3),
      ]),
    ).toEqual(lines.map((match) => match.slice(1)));
    for (const hit of hits) {
      expect(hit.path).toBe(`assets/${hit.file}`);
      expect(hit.file).toBe(ISSEBYA.sounds.click!.file);
    }
  });

  it("gives no hits for an edit without sounds", () => {
    const fixture = all.find((entry) => entry.name === "rethink-work-baseline")!;
    expect(soundHits(fixture.edit, fixture.transcript, ISSEBYA)).toEqual([]);
  });

  it("refuses an invalid edit", () => {
    const fixture = all[0]!;
    expect(() => soundHits({ format: 2 }, fixture.transcript, ISSEBYA)).toThrow();
  });
});
