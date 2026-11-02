"use client";

import type { HyperframesPlayer } from "@hyperframes/player";
import { useEffect, useRef, useState } from "react";
import { type MediaState, activeAt, canPlayFrom } from "@/lib/preview-clock";
import { recordSoundSchedule } from "@/lib/preview-test-hooks";
import { type SoundHit, scheduleAt } from "@/lib/sound-schedule";

interface Props {
  // The page handed to the player (already transformed for the preview).
  html: string;
  versionId: string;
  hits: SoundHit[];
  // The encoded sound files the hits name, by preset path.
  soundBytes: Record<string, ArrayBuffer>;
}

interface Tracked extends MediaState {
  el: HTMLMediaElement;
}

// What a waiting hold listens to on each medium: any of these can make it
// ready to play from the target.
const MEDIA_EVENTS = ["canplay", "canplaythrough", "seeked", "loadeddata", "progress", "waiting"];
// What tells a playing preview a video can no longer play on.
const STALL_EVENTS = ["waiting", "stalled"];
// How far a video may sit from where it should be before the hold moves it.
const SEEK_SLACK = 0.1;
// A resume that never settles must not hang playback.
const RESUME_TIMEOUT_MS = 500;

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = (safe - minutes * 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${rest}`;
}

// The timed videos of the composition, and the player's parent-frame copies
// when it moved playback there (autoplay blocked): read only.
function mediaOf(player: HyperframesPlayer): Tracked[] {
  const tracked: Tracked[] = [];
  let doc: Document | null = null;
  try {
    doc = player.iframeElement?.contentDocument ?? null;
  } catch {
    doc = null;
  }
  for (const el of doc?.querySelectorAll<HTMLVideoElement>("video[data-start]") ?? []) {
    const start = Number(el.dataset.start);
    const duration = Number(el.dataset.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || !el.getAttribute("src")) continue;
    tracked.push({
      el,
      start,
      duration,
      readyState: el.readyState,
      seeking: el.seeking,
      position: el.currentTime,
    });
  }
  if (player._audioOwner === "parent") {
    for (const entry of player._parentMedia) {
      tracked.push({
        el: entry.el,
        start: entry.start,
        duration: entry.duration,
        readyState: entry.el.readyState,
        seeking: entry.el.seeking,
      });
    }
  }
  return tracked;
}

// The wrapper around <hyperframes-player>: it owns play, pause and seek, and
// starts the player's clock only once every video playing at the current
// point can play from there (first play, every seek, every stall). The
// edit's sounds play through one AudioContext, scheduled against the clock at
// each start and cancelled at every pause, seek and stall.
export function PreviewPlayer({ html, versionId, hits, soundBytes }: Props) {
  const playerRef = useRef<HyperframesPlayer>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Promise<Map<string, AudioBuffer>>>(Promise.resolve(new Map()));
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const generationRef = useRef(0);
  const intentRef = useRef<"paused" | "playing">("paused");
  const waitCleanupRef = useRef<(() => void) | null>(null);
  const stallCleanupRef = useRef<(() => void) | null>(null);
  const hitsRef = useRef(hits);
  const expectedVideosRef = useRef(0);

  const [defined, setDefined] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [intent, setIntent] = useState<"paused" | "playing">("paused");
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    hitsRef.current = hits;
    expectedVideosRef.current = html.split("<video ").length - 1;
  }, [hits, html]);

  // The custom element is registered in the browser only, never at module
  // load on the server.
  useEffect(() => {
    let active = true;
    void import("@hyperframes/player").then(() => {
      if (active) setDefined(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // One AudioContext per mounted preview; the sounds are decoded on open
  // (decoding works on a suspended context).
  useEffect(() => {
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    buffersRef.current = Promise.all(
      Object.entries(soundBytes).map(
        async ([file, bytes]) => [file, await ctx.decodeAudioData(bytes.slice(0))] as const,
      ),
    )
      .then((entries) => new Map(entries))
      .catch((error: unknown) => {
        console.error("studio: preview sounds not decoded:", (error as Error).message);
        return new Map<string, AudioBuffer>();
      });
    return () => {
      for (const source of sourcesRef.current) source.disconnect();
      sourcesRef.current = [];
      ctxRef.current = null;
      void ctx.close();
    };
  }, [soundBytes]);

  function stopSounds() {
    for (const source of sourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Never started or already stopped.
      }
      source.disconnect();
    }
    sourcesRef.current = [];
  }

  function stopWatching() {
    waitCleanupRef.current?.();
    waitCleanupRef.current = null;
    stallCleanupRef.current?.();
    stallCleanupRef.current = null;
  }

  function canStart(player: HyperframesPlayer, t: number): boolean {
    if (!player.ready || !player.assetsReady) return false;
    const media = mediaOf(player);
    if (media.length < expectedVideosRef.current) return false;
    return canPlayFrom(media, t);
  }

  async function scheduleSounds(ctx: AudioContext, playhead: number, ctxTime: number) {
    const buffers = await buffersRef.current;
    const byId = new Map(hitsRef.current.map((hit) => [hit.id, hit]));
    const starts = scheduleAt(hitsRef.current, playhead, ctxTime);
    for (const start of starts) {
      const hit = byId.get(start.id);
      const buffer = hit && buffers.get(hit.file);
      if (!hit || !buffer) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = hit.gain;
      source.connect(gain).connect(ctx.destination);
      source.start(start.when, start.offset);
      sourcesRef.current.push(source);
    }
    recordSoundSchedule({ ctxTime, playhead }, starts);
  }

  // While playing, a video that stops being able to play holds the clock
  // again at the current point.
  function watchForStalls(player: HyperframesPlayer, generation: number) {
    const listened: HTMLMediaElement[] = [];
    const onStall = (event: Event) => {
      if (generation !== generationRef.current || intentRef.current !== "playing") return;
      const t = player.currentTime;
      const active = activeAt(mediaOf(player), t).some((item) => item.el === event.target);
      if (active) holdThenStart(t);
    };
    const attach = () => {
      for (const { el } of mediaOf(player)) {
        if (listened.includes(el)) continue;
        listened.push(el);
        for (const name of STALL_EVENTS) el.addEventListener(name, onStall);
      }
    };
    attach();
    player.addEventListener("audioownershipchange", attach);
    stallCleanupRef.current = () => {
      player.removeEventListener("audioownershipchange", attach);
      for (const el of listened) {
        for (const name of STALL_EVENTS) el.removeEventListener(name, onStall);
      }
    };
  }

  async function start(player: HyperframesPlayer, generation: number) {
    // Every sound decoded before the clock may run.
    await buffersRef.current;
    const ctx = ctxRef.current;
    if (ctx && ctx.state !== "running") {
      await Promise.race([
        ctx.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
      ]);
    }
    if (generation !== generationRef.current) return;
    const ctxTime = ctx?.currentTime ?? 0;
    const playhead = player.currentTime;
    player.play();
    setHolding(false);
    watchForStalls(player, generation);
    if (ctx) await scheduleSounds(ctx, playhead, ctxTime);
  }

  // The one routine for play, seek-while-playing and stall: stop the clock and
  // the sounds, move to t, and start again only once the media can play from
  // there. A newer action supersedes a pending wait.
  function holdThenStart(t: number) {
    const player = playerRef.current;
    if (!player) return;
    const generation = ++generationRef.current;
    intentRef.current = "playing";
    setIntent("playing");
    stopWatching();
    stopSounds();
    if (!player.paused) player.pause();
    if (Math.abs(player.currentTime - t) > 0.001) player.seek(t);
    setPosition(t);
    setHolding(true);
    // A video left where it was is moved to the target, so its readiness
    // is measured there.
    for (const item of activeAt(mediaOf(player), t)) {
      if (Math.abs(item.el.currentTime - (t - item.start)) > SEEK_SLACK) {
        item.el.currentTime = t - item.start;
      }
    }

    const listened: EventTarget[] = [];
    const check = () => {
      if (generation !== generationRef.current) return;
      for (const { el } of mediaOf(player)) {
        if (listened.includes(el)) continue;
        listened.push(el);
        for (const name of MEDIA_EVENTS) el.addEventListener(name, check);
      }
      if (!canStart(player, t)) return;
      waitCleanupRef.current?.();
      waitCleanupRef.current = null;
      void start(player, generation);
    };
    player.addEventListener("ready", check);
    player.addEventListener("assetsready", check);
    player.addEventListener("audioownershipchange", check);
    waitCleanupRef.current = () => {
      player.removeEventListener("ready", check);
      player.removeEventListener("assetsready", check);
      player.removeEventListener("audioownershipchange", check);
      for (const el of listened) {
        for (const name of MEDIA_EVENTS) el.removeEventListener(name, check);
      }
    };
    check();
  }

  function pause() {
    const player = playerRef.current;
    generationRef.current += 1;
    intentRef.current = "paused";
    setIntent("paused");
    setHolding(false);
    stopWatching();
    stopSounds();
    if (player && !player.paused) player.pause();
  }

  function onPlayClick() {
    if (intentRef.current === "playing") {
      pause();
      return;
    }
    // Resumed inside the click, the user gesture the browser asks for.
    void ctxRef.current?.resume().catch(() => undefined);
    const player = playerRef.current;
    if (!player) return;
    const t = player.currentTime >= duration ? 0 : player.currentTime;
    holdThenStart(t);
  }

  function onSeek(value: number) {
    setPosition(value);
    if (intentRef.current === "playing") {
      holdThenStart(value);
      return;
    }
    playerRef.current?.seek(value);
  }

  // The player's own events: its load, its clock and its end.
  useEffect(() => {
    const player = playerRef.current;
    if (!defined || !player) return;
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<{ duration?: number }>).detail;
      setDuration(detail?.duration ?? player.duration);
      setPlayerReady(true);
    };
    const onTime = (event: Event) => {
      const detail = (event as CustomEvent<{ currentTime?: number }>).detail;
      setPosition(detail?.currentTime ?? player.currentTime);
    };
    const onEnded = () => {
      generationRef.current += 1;
      intentRef.current = "paused";
      setIntent("paused");
      setHolding(false);
      stopWatching();
      stopSounds();
    };
    if (player.ready) {
      setDuration(player.duration);
      setPlayerReady(true);
    }
    player.addEventListener("ready", onReady);
    player.addEventListener("timeupdate", onTime);
    player.addEventListener("ended", onEnded);
    return () => {
      player.removeEventListener("ready", onReady);
      player.removeEventListener("timeupdate", onTime);
      player.removeEventListener("ended", onEnded);
      generationRef.current += 1;
      stopWatching();
      stopSounds();
    };
  }, [defined]);

  const loading = !playerReady || holding;

  return (
    <div
      data-preview={loading ? "loading" : "ready"}
      data-preview-version={versionId}
      className="flex w-full max-w-sm flex-col gap-2"
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md bg-black">
        {defined && (
          <hyperframes-player
            ref={playerRef}
            width="1080"
            height="1920"
            srcdoc={html}
            disable-click-to-play=""
            assets-loading-ui="none"
            no-load-timeout=""
            className="block h-full w-full"
          />
        )}
        {loading && (
          <p
            role="status"
            className="absolute inset-x-0 bottom-2 text-center text-sm font-medium text-white"
          >
            Loading
          </p>
        )}
      </div>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={onPlayClick}
          disabled={!playerReady}
          className="rounded-md bg-stone-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {intent === "playing" ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          aria-label="Position"
          min="0"
          max={duration}
          step="0.01"
          value={Math.min(position, duration)}
          disabled={!playerReady}
          onChange={(event) => onSeek(Number(event.target.value))}
          className="min-w-0 flex-1"
        />
        <span className="tabular-nums text-stone-600">
          {formatTime(position)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
