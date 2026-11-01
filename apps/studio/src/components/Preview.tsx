"use client";

import type { HeadTrack, Transcript } from "@edit-issebya/edit";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PreviewSourcesResult, previewSources } from "@/app/preview-actions";
import { isChromium } from "@/lib/browser";
import { previewPage } from "@/lib/preview-page";
import { capture } from "@/lib/track";
import { type PreviewHit, PreviewPlayer } from "./PreviewPlayer";

// Same-origin route serving the preset's fonts and sounds.
const EDIT_ASSETS = "/studio/api/edit-assets/";

declare global {
  interface Window {
    // Under automation only, in memory: the version shown and the builder's
    // page before its URLs were mapped, for the parity spec.
    __preview?: { versionId: string; html: string };
  }
}

type Loaded =
  | {
      state: "ready";
      versionId: string;
      srcdoc: string;
      hits: PreviewHit[];
      buffers: ReadonlyMap<string, AudioBuffer>;
    }
  | { state: "waiting" }
  | { state: "error" };

const WAITING: ReadonlySet<PreviewSourcesResult["state"]> = new Set(["no-version", "no-previews"]);

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`preview: ${response.status} for a preview file`);
  return response;
}

// Decoded once per sound file and kept across rebuilds. Decoding needs no
// output device, so an offline context does it before any Play.
async function decodeSounds(
  hits: { path: string; file: string }[],
  cache: Map<string, AudioBuffer>,
  signal: AbortSignal,
): Promise<void> {
  const missing = [...new Map(hits.map((hit) => [hit.path, hit.file])).entries()].filter(
    ([path]) => !cache.has(path),
  );
  if (missing.length === 0) return;
  const decoder = new OfflineAudioContext(1, 1, 48_000);
  await Promise.all(
    missing.map(async ([path, file]) => {
      const bytes = await (await fetchOk(`${EDIT_ASSETS}${file}`, signal)).arrayBuffer();
      cache.set(path, await decoder.decodeAudioData(bytes));
    }),
  );
}

// Fetches what the reel's current version needs, builds the page with the
// shared builder (nothing is stored) and maps it for the player.
async function loadPreview(
  reelId: string,
  signal: AbortSignal,
  sounds: Map<string, AudioBuffer>,
): Promise<Loaded> {
  const sources = await previewSources(reelId);
  if (sources.state !== "ready")
    return WAITING.has(sources.state) ? { state: "waiting" } : { state: "error" };
  // Loaded on demand: the builder and its HarfBuzz measurer stay out of the page bundle.
  const { ISSEBYA, build, createMeasurer, soundHits } = await import("@edit-issebya/edit");
  const fontKeys = Object.keys(ISSEBYA.fonts);
  const json = async (url: string) => (await fetchOk(url, signal)).json() as Promise<unknown>;
  const [edit, transcript, headTrack, ...fontBytes] = await Promise.all([
    json(sources.urls.version),
    json(sources.urls.transcript),
    json(sources.urls.headTrack),
    ...fontKeys.map(async (key) => {
      const response = await fetchOk(`${EDIT_ASSETS}${ISSEBYA.fonts[key]!.file}`, signal);
      return new Uint8Array(await response.arrayBuffer());
    }),
  ]);
  const input = {
    edit,
    transcript: transcript as Transcript,
    headTrack: headTrack as HeadTrack,
    preset: ISSEBYA,
  };
  const measurer = createMeasurer(
    Object.fromEntries(fontKeys.map((key, index) => [key, fontBytes[index] as Uint8Array])),
  );
  let built: ReturnType<typeof build>;
  try {
    built = build({ ...input, measurer });
  } finally {
    measurer.close();
  }
  const hits = soundHits(edit, input.transcript, ISSEBYA);
  await decodeSounds(hits, sounds, signal);

  const urls: Record<string, string> = {};
  for (const asset of built.assets) {
    if (asset.role === "footage") urls[asset.path] = sources.urls.footage;
    else if (asset.role === "cutout") urls[asset.path] = sources.urls.cutout;
    else urls[asset.path] = `${EDIT_ASSETS}${asset.path.replace(/^assets\//, "")}`;
  }
  if (navigator.webdriver === true) {
    window.__preview = { versionId: sources.versionId, html: built.html };
  }
  return {
    state: "ready",
    versionId: sources.versionId,
    srcdoc: previewPage(built.html, built.assets, urls),
    hits,
    buffers: new Map(sounds),
  };
}

const noSubscribe = () => () => {};

// The live preview of the reel's current version: built in the browser on
// open and again whenever `versionId` changes (LiveReel follows it through
// Realtime), never polled. Opening it sends studio_preview_opened once.
export function Preview({ reelId, versionId }: { reelId: string; versionId: string }) {
  const [loaded, setLoaded] = useState<(Loaded & { for: string }) | null>(null);
  const sounds = useRef(new Map<string, AudioBuffer>());
  const opened = useRef(false);
  const chromium = useSyncExternalStore(
    noSubscribe,
    () => isChromium(navigator),
    () => true,
  );

  useEffect(() => {
    // Once per mount: neither StrictMode's second effect nor a rebuild sends it again.
    if (opened.current) return;
    opened.current = true;
    capture("studio_preview_opened", { reel_id: reelId });
  }, [reelId]);

  useEffect(() => {
    const controller = new AbortController();
    loadPreview(reelId, controller.signal, sounds.current).then(
      (result) => {
        if (!controller.signal.aborted) setLoaded({ ...result, for: versionId });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("studio: preview not built:", (error as Error).message);
        setLoaded({ state: "error", for: versionId });
      },
    );
    return () => controller.abort();
  }, [reelId, versionId]);

  const current = loaded?.for === versionId ? loaded : null;

  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-2">
      <h2 id="preview-heading" className="text-lg font-semibold">
        Preview
      </h2>
      {!chromium && (
        <p className="text-sm text-stone-600">
          The preview is built for Chrome; it may not play correctly in this browser.
        </p>
      )}
      {!current ? (
        <p className="text-sm text-stone-600">Loading preview</p>
      ) : current.state === "waiting" ? (
        <p className="text-sm text-stone-600">The preview appears once processing has finished.</p>
      ) : current.state === "error" ? (
        <p className="text-sm text-red-700">
          The preview could not be loaded. Reload the page to try again.
        </p>
      ) : (
        <PreviewPlayer
          key={current.versionId}
          srcdoc={current.srcdoc}
          hits={current.hits}
          buffers={current.buffers}
        />
      )}
    </section>
  );
}
