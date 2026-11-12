import type { Edit } from "@edit-issebya/edit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSITE_MAX_SECONDS,
  type MediaFacts,
  type RenderSettings,
  type RouteInput,
  renderRoute,
  renderSettings,
} from "./render-route.ts";
import { fixtureEdit } from "./render-test-support.ts";

const DEFAULTS: RenderSettings = { path: "composite", mode: "match" };

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  width: 1080,
  height: 1920,
  rate: "30/1",
  avgRate: "30/1",
  frames: 81,
  range: "tv",
  pixFmt: "yuv420p",
  hasAudio: true,
  ...over,
});

describe("renderSettings", () => {
  it("is the composite in match mode by default", () => {
    expect(renderSettings({})).toEqual(DEFAULTS);
    expect(renderSettings({ WORKER_RENDER_PATH: " ", WORKER_RENDER_MODE: "" })).toEqual(DEFAULTS);
  });

  it("reads the path and the mode", () => {
    expect(renderSettings({ WORKER_RENDER_PATH: "single" })).toEqual({
      path: "single",
      mode: "match",
    });
    expect(renderSettings({ WORKER_RENDER_MODE: " clean " })).toEqual({
      path: "composite",
      mode: "clean",
    });
  });

  it("refuses any other value", () => {
    expect(() => renderSettings({ WORKER_RENDER_PATH: "fast" })).toThrow(
      "WORKER_RENDER_PATH must be composite or single, got fast",
    );
    expect(() => renderSettings({ WORKER_RENDER_MODE: "Match" })).toThrow(
      "WORKER_RENDER_MODE must be match or clean, got Match",
    );
  });
});

describe("renderRoute", () => {
  let base: Pick<RouteInput, "edit" | "transcript">;
  let edit: Edit;

  beforeAll(async () => {
    const fixture = await fixtureEdit();
    edit = fixture.edit;
    base = { edit, transcript: fixture.transcript };
  });

  const route = (over: Partial<RouteInput> = {}) =>
    renderRoute({ settings: DEFAULTS, footage: facts(), masks: [], ...base, ...over });
  const withClip = (change: (clip: Edit["tracks"]["footage"][number]) => void): Edit => {
    const changed = structuredClone(edit);
    change(changed.tracks.footage[0]!);
    return changed;
  };

  it("is the composite for one plain 30 fps clip over the whole reel, in the settings' mode", () => {
    expect(route()).toEqual({ path: "composite", mode: "match" });
    expect(route({ settings: { path: "composite", mode: "clean" } })).toEqual({
      path: "composite",
      mode: "clean",
    });
  });

  it("is the composite before any probe when the edit's own rules pass", () => {
    expect(route({ footage: undefined, masks: undefined })).toEqual({
      path: "composite",
      mode: "match",
    });
  });

  it("is the single call when the setting says so, whatever the version", () => {
    expect(route({ settings: { path: "single", mode: "clean" } })).toEqual({
      path: "single",
      reason: "setting",
    });
  });

  it("is the single call for no footage clip or several", () => {
    const none = structuredClone(edit);
    none.tracks.footage = [];
    expect(route({ edit: none })).toEqual({ path: "single", reason: "footage_clips" });
    const two = structuredClone(edit);
    two.tracks.footage.push({ ...two.tracks.footage[0]!, id: "footage-2" });
    expect(route({ edit: two })).toEqual({ path: "single", reason: "footage_clips" });
  });

  it("is the single call for a footage clip with a style or hidden spans", () => {
    const styled = withClip((clip) => {
      clip.style = { filter: "grayscale(1)" };
    });
    expect(route({ edit: styled })).toEqual({ path: "single", reason: "footage_style" });
    const hidden = withClip((clip) => {
      clip.hidden = [{ start: { word: "w0001" }, end: { word: "w0002", edge: "end" } }];
    });
    expect(route({ edit: hidden })).toEqual({ path: "single", reason: "footage_hidden" });
    // An empty style and no hidden span change nothing.
    const plain = withClip((clip) => {
      clip.style = {};
      clip.hidden = [];
    });
    expect(route({ edit: plain })).toEqual({ path: "composite", mode: "match" });
  });

  it("is the single call for a footage clip that does not cover the whole reel", () => {
    const late = withClip((clip) => {
      clip.start = { time: 0.5 };
    });
    expect(route({ edit: late })).toEqual({ path: "single", reason: "footage_span" });
    const early = withClip((clip) => {
      clip.end = { time: edit.duration - 0.5 };
    });
    expect(route({ edit: early })).toEqual({ path: "single", reason: "footage_span" });
  });

  it("is the single call from 120 s on", () => {
    expect(COMPOSITE_MAX_SECONDS).toBe(120);
    const long = (duration: number): Edit => {
      const changed = structuredClone(edit);
      changed.duration = duration;
      changed.tracks.footage[0]!.end = { time: duration };
      return changed;
    };
    expect(route({ edit: long(119.9) })).toEqual({ path: "composite", mode: "match" });
    expect(route({ edit: long(120) })).toEqual({ path: "single", reason: "long_reel" });
    expect(route({ edit: long(300) })).toEqual({ path: "single", reason: "long_reel" });
  });

  it("is the single call for footage that is not 30 fps at a constant rate with its frames counted", () => {
    for (const footage of [
      facts({ rate: "25/1", avgRate: "25/1" }),
      facts({ rate: "30000/1001", avgRate: "30000/1001" }),
      facts({ avgRate: "2997/100" }),
      facts({ frames: Number.NaN }),
      facts({ frames: 0 }),
    ]) {
      expect(route({ footage })).toEqual({ path: "single", reason: "footage_fps" });
    }
  });

  it("is the single call for footage that is not 8-bit 4:2:0 or has no sound", () => {
    expect(route({ footage: facts({ pixFmt: "yuv420p10le" }) })).toEqual({
      path: "single",
      reason: "footage_format",
    });
    expect(route({ footage: facts({ pixFmt: "yuvj420p", range: "pc" }) })).toEqual({
      path: "composite",
      mode: "match",
    });
    expect(route({ footage: facts({ hasAudio: false }) })).toEqual({
      path: "single",
      reason: "no_audio",
    });
  });

  it("is the single call for masks of mixed sizes or ranges, or a mask that is not 30 fps", () => {
    const mask = (over: Partial<MediaFacts> = {}) =>
      facts({ hasAudio: false, frames: 52, ...over });
    expect(route({ masks: [mask(), mask()] })).toEqual({ path: "composite", mode: "match" });
    // Masks smaller than the frame are fine when they are all the same.
    const small = { width: 720, height: 1280 };
    expect(route({ masks: [mask(small), mask(small)] })).toEqual({
      path: "composite",
      mode: "match",
    });
    expect(route({ masks: [mask(), mask(small)] })).toEqual({
      path: "single",
      reason: "mask_sizes",
    });
    expect(route({ masks: [mask(), mask({ range: "pc" })] })).toEqual({
      path: "single",
      reason: "mask_sizes",
    });
    expect(route({ masks: [mask(), mask({ rate: "25/1" })] })).toEqual({
      path: "single",
      reason: "mask_fps",
    });
    expect(route({ masks: [mask({ frames: Number.NaN })] })).toEqual({
      path: "single",
      reason: "mask_fps",
    });
  });

  it("names the first reason in a fixed order", () => {
    const styled = withClip((clip) => {
      clip.style = { opacity: "0.5" };
    });
    expect(route({ edit: styled, footage: facts({ rate: "25/1" }) })).toEqual({
      path: "single",
      reason: "footage_style",
    });
    expect(route({ settings: { path: "single", mode: "match" }, edit: styled })).toEqual({
      path: "single",
      reason: "setting",
    });
  });
});
