"use client";

import type { HyperframesPlayer } from "@hyperframes/player";
import { useEffect, useRef, useState } from "react";
import { isStalled, whenReady } from "@/lib/media-ready";
import { playingMedia } from "@/lib/player-media";
import { scheduleFrom } from "@/lib/sound-schedule";

// One click of the sounds track (`SoundHit` from @edit-issebya/edit).
export interface PreviewHit {
  id: string;
  at: number;
  path: string;
  gain: number;
}

type ScheduledSoundRecord =
  | { id: string; when: number; contextTime: number; playerTime: number }
  | { id: string; stopped: true };

declare global {
  interface Window {
    // Set only by the Playwright specs (page.addInitScript) to observe the
    // clicks the preview schedules.
    __scheduledSounds?: ScheduledSoundRecord[];
  }
}

// Under automation, and only when a spec put an array on the window; in
// memory only.
function recordForTests(record: ScheduledSoundRecord): void {
  if (navigator.webdriver !== true || !Array.isArray(window.__scheduledSounds)) return;
  window.__scheduledSounds.push(record);
}

type State = "loading" | "paused" | "holding" | "playing";

interface ActiveSound {
  id: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

// The HyperFrames player under the studio's own controls. The player's clock
// never advances while the footage or the cut-out cannot play from the current
// point: on Play, after every seek and after a stall the wrapper holds the
// clock ("Loading") and starts it only once both videos can play from there.
// The clicks of the sounds track are started through one AudioContext at
// their offset from the moment the clock starts, and stopped on pause, seek
// and the end. The player's own controls, click-to-play and loading card are
// off. No timer: the time shown follows the player's events.
export function PreviewPlayer({
  srcdoc,
  hits,
  buffers,
}: {
  srcdoc: string;
  hits: PreviewHit[];
  buffers: ReadonlyMap<string, AudioBuffer>;
}) {
  const playerRef = useRef<HyperframesPlayer>(null);
  const [defined, setDefined] = useState(false);
  const [state, setState] = useState<State>("loading");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // The pending hold's abort, the context and the clicks started through it.
  const run = useRef<AbortController | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const active = useRef<ActiveSound[]>([]);
  const stateRef = useRef<State>("loading");

  const go = (next: State) => {
    stateRef.current = next;
    setState(next);
  };

  const cancelSounds = () => {
    for (const sound of active.current) {
      sound.source.onended = null;
      sound.source.stop();
      sound.source.disconnect();
      sound.gain.disconnect();
      recordForTests({ id: sound.id, stopped: true });
    }
    active.current = [];
  };

  // The context exists only for an edit with clicks.
  const context = (): AudioContext | null => {
    if (hits.length === 0) return null;
    audio.current ??= new AudioContext();
    return audio.current;
  };

  const startSounds = (ctx: AudioContext, contextTime: number, playerTime: number) => {
    for (const sound of scheduleFrom(hits, playerTime, contextTime)) {
      const buffer = buffers.get(sound.path);
      if (!buffer) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = sound.gain;
      source.connect(gain).connect(ctx.destination);
      const entry = { id: sound.id, source, gain };
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        active.current = active.current.filter((other) => other !== entry);
      };
      source.start(sound.when);
      active.current.push(entry);
      recordForTests({ id: sound.id, when: sound.when, contextTime, playerTime });
    }
  };

  // Holds the clock at the player's time, waits until both videos can play
  // from there, then starts the clock and schedules the clicks from it. A
  // later play, seek, pause or stall aborts a wait still pending.
  const startFromHere = async (player: HyperframesPlayer) => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    cancelSounds();
    player.pause();
    go("holding");
    const ctx = context();
    // Inside the click's activation, before any wait.
    void ctx?.resume();
    const at = player.currentTime;
    try {
      await whenReady(playingMedia(player), controller.signal, at);
    } catch {
      return;
    }
    // The clicks are timed from the moment the clock actually starts.
    const started = new Promise<void>((resolve) => {
      if (!player.paused) return resolve();
      player.addEventListener("play", () => resolve(), { once: true });
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    player.play();
    await started;
    if (controller.signal.aborted) return;
    if (ctx) startSounds(ctx, ctx.currentTime, player.currentTime);
    go("playing");
  };

  const stop = (player: HyperframesPlayer) => {
    run.current?.abort();
    run.current = null;
    cancelSounds();
    player.pause();
  };

  useEffect(() => {
    let alive = true;
    // Defines the custom element; it touches HTMLElement at load, so client only.
    void import("@hyperframes/player").then(() => {
      if (alive) setDefined(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!defined || !player) return;
    let media: HTMLMediaElement[] = [];
    const onReady = () => {
      setDuration(player.duration);
      setTime(player.currentTime);
      if (stateRef.current === "loading") go("paused");
    };
    // A stall while playing: hold, then resume from the held time.
    const onStall = (event: Event) => {
      if (stateRef.current !== "playing") return;
      if (isStalled(event.target as HTMLMediaElement)) void startFromHere(player);
    };
    const watch = () => {
      for (const el of media) {
        el.removeEventListener("waiting", onStall);
        el.removeEventListener("stalled", onStall);
      }
      media = playingMedia(player);
      for (const el of media) {
        el.addEventListener("waiting", onStall);
        el.addEventListener("stalled", onStall);
      }
    };
    const onTime = () => {
      setTime(player.currentTime);
      if (stateRef.current !== "playing") return;
      if (playingMedia(player).some(isStalled)) void startFromHere(player);
    };
    const onPlay = () => watch();
    const onEnded = () => {
      stop(player);
      setTime(player.currentTime);
      go("paused");
    };
    player.addEventListener("ready", onReady);
    player.addEventListener("timeupdate", onTime);
    player.addEventListener("play", onPlay);
    player.addEventListener("ended", onEnded);
    if (player.ready) onReady();
    return () => {
      player.removeEventListener("ready", onReady);
      player.removeEventListener("timeupdate", onTime);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("ended", onEnded);
      for (const el of media) {
        el.removeEventListener("waiting", onStall);
        el.removeEventListener("stalled", onStall);
      }
      run.current?.abort();
      cancelSounds();
    };
    // The handlers read refs only; the player mounts once per srcdoc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defined]);

  useEffect(
    () => () => {
      void audio.current?.close();
      audio.current = null;
    },
    [],
  );

  const onPlayPause = () => {
    const player = playerRef.current;
    if (!player || state === "loading") return;
    if (state === "paused") {
      void startFromHere(player);
    } else {
      stop(player);
      setTime(player.currentTime);
      go("paused");
    }
  };

  const onSeek = (value: number) => {
    const player = playerRef.current;
    if (!player || state === "loading") return;
    const wasPlaying = state !== "paused";
    stop(player);
    player.seek(value);
    setTime(value);
    if (wasPlaying) void startFromHere(player);
    else go("paused");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="mx-auto aspect-[9/16] w-full max-w-sm overflow-hidden rounded-md bg-black">
        {defined && (
          <hyperframes-player
            ref={playerRef}
            srcdoc={srcdoc}
            width="1080"
            height="1920"
            disable-click-to-play=""
            assets-loading-ui="none"
            className="block h-full w-full"
          />
        )}
      </div>
      <div className="mx-auto flex w-full max-w-sm items-center gap-3 text-sm">
        <button
          type="button"
          onClick={onPlayPause}
          disabled={state === "loading"}
          className="rounded-md border border-stone-300 bg-white px-3 py-1 font-medium disabled:opacity-50"
        >
          {state === "paused" || state === "loading" ? "Play" : "Pause"}
        </button>
        <input
          type="range"
          aria-label="Position"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(time, duration)}
          disabled={state === "loading"}
          onChange={(event) => onSeek(Number(event.target.value))}
          className="min-w-0 flex-1"
        />
        <span data-testid="preview-time" className="tabular-nums text-stone-600">
          {formatTime(time)} / {formatTime(duration)}
        </span>
      </div>
      <p role="status" className="mx-auto h-5 w-full max-w-sm text-sm text-stone-600">
        {state === "holding" || state === "loading" ? "Loading" : ""}
      </p>
    </div>
  );
}
