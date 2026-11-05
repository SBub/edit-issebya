"use client";

import type { HyperframesPlayer } from "@hyperframes/player";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { type MediaState, activeAt, canPlayFrom, mediaTimeAt } from "@/lib/preview-clock";
import { recordSoundSchedule } from "@/lib/preview-test-hooks";
import { PlatformZones } from "./PlatformZones";
import { type SoundHit, scheduleAt } from "@/lib/sound-schedule";
import { clockText } from "@/lib/tracks-timeline";

interface Props {
  // The page handed to the player (already transformed for the preview).
  html: string;
  versionId: string;
  hits: SoundHit[];
  // The encoded sound files the hits name, by preset path.
  soundBytes: Record<string, ArrayBuffer>;
  // Told the clock's position wherever the player's own position changes (its
  // clock, a seek, a hold): the tracks timeline's playhead.
  onPosition?: (seconds: number) => void;
  // Whether the preview fills the edit area (the page holds the state and
  // hides the tracks timeline): Zones is hidden then, and expanding switches
  // Zones off. With onExpandedChange, an expand or collapse button ends the row.
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  // Where to start once the player is ready (the previous version's position
  // on an automatic switch, clamped to this version's duration), and whether
  // to start playing from there (the previous version's intent). Default: 0,
  // paused.
  startAt?: number;
  autoPlay?: boolean;
  // Told the play or pause intent wherever it changes.
  onIntent?: (intent: "paused" | "playing") => void;
  // The seek the tracks timeline's ruler drives (the one scrubber).
  ref?: Ref<PreviewPlayerHandle>;
}

export interface PreviewPlayerHandle {
  // Moves the clock to `seconds` through the player's own seek: playing stays
  // playing (hold, then start from there), paused stays paused. Ignored until
  // the player is ready.
  seek: (seconds: number) => void;
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
// The control row's outer icons sit flush with the row's edges (the tracks
// panel's edges): each viewBox starts or ends where its glyph's visible edge
// is (stroke included), and the icon sits at that end of its 40 px button.
const PLAY_VIEWBOX = "7.4 0 24 24";
const PAUSE_VIEWBOX = "6 0 24 24";
const EXPAND_VIEWBOX = "-2 0 24 24";

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
    const mediaStart = Number(el.dataset.mediaStart ?? 0);
    tracked.push({
      el,
      start,
      duration,
      mediaStart: Number.isFinite(mediaStart) ? mediaStart : 0,
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
export function PreviewPlayer({
  html,
  versionId,
  hits,
  soundBytes,
  onPosition,
  expanded = false,
  onExpandedChange,
  startAt = 0,
  autoPlay = false,
  onIntent,
  ref,
}: Props) {
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
  const onPositionRef = useRef(onPosition);
  const reportedRef = useRef(0);
  const onIntentRef = useRef(onIntent);
  // The start position and intent are applied once, when the player is ready.
  const startedRef = useRef(false);
  const startRef = useRef({ startAt, autoPlay });

  const [defined, setDefined] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [intent, setIntent] = useState<"paused" | "playing">("paused");
  const [holding, setHolding] = useState(false);
  // The platform zones over the preview: off on every open, never saved.
  const [zones, setZones] = useState(false);

  useEffect(() => {
    hitsRef.current = hits;
    expectedVideosRef.current = html.split("<video ").length - 1;
  }, [hits, html]);

  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  useEffect(() => {
    onIntentRef.current = onIntent;
  }, [onIntent]);

  useEffect(() => {
    onIntentRef.current?.(intent);
  }, [intent]);

  // The position shown here and reported to the page, set together.
  function report(seconds: number) {
    reportedRef.current = seconds;
    setPosition(seconds);
    onPositionRef.current?.(seconds);
  }

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
    report(t);
    setHolding(true);
    // A video left where it was is moved to the target, so its readiness
    // is measured there.
    for (const item of activeAt(mediaOf(player), t)) {
      if (Math.abs(item.el.currentTime - mediaTimeAt(item, t)) > SEEK_SLACK) {
        item.el.currentTime = mediaTimeAt(item, t);
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

  // The ruler's seek, the way the old Position slider did it: playing stays
  // playing through the hold-then-start routine, paused just moves the clock.
  function onSeek(value: number) {
    report(value);
    if (intentRef.current === "playing") {
      holdThenStart(value);
      return;
    }
    playerRef.current?.seek(value);
  }

  useImperativeHandle(ref, () => ({
    seek: (seconds: number) => {
      if (playerReady) onSeek(seconds);
    },
  }));

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
      report(detail?.currentTime ?? player.currentTime);
    };
    const onEnded = () => {
      generationRef.current += 1;
      intentRef.current = "paused";
      setIntent("paused");
      setHolding(false);
      stopWatching();
      stopSounds();
    };
    // The player takes the time of every message from its frame but sends
    // `timeupdate` at most every 100 ms, so the frames a pause lets through
    // (it reaches the frame by message) can land without one: the clock and
    // the playhead would rest a few frames before the player. While paused,
    // each message from the frame is followed by the player's time when it
    // differs. The player listened first, so its time is already applied.
    const onMessage = (event: MessageEvent) => {
      if (intentRef.current !== "paused") return;
      if (event.source !== player.iframeElement?.contentWindow) return;
      if (player.currentTime !== reportedRef.current) report(player.currentTime);
    };
    if (player.ready) {
      setDuration(player.duration);
      setPlayerReady(true);
    }
    player.addEventListener("ready", onReady);
    player.addEventListener("timeupdate", onTime);
    player.addEventListener("ended", onEnded);
    window.addEventListener("message", onMessage);
    return () => {
      player.removeEventListener("ready", onReady);
      player.removeEventListener("timeupdate", onTime);
      player.removeEventListener("ended", onEnded);
      window.removeEventListener("message", onMessage);
      generationRef.current += 1;
      stopWatching();
      stopSounds();
    };
  }, [defined]);

  // An automatic switch: once ready, the new version continues from where the
  // previous one was, playing or paused as it was. Playing goes through the
  // same hold-then-start routine as a click, so the clock still never runs
  // before the videos can play from there.
  useEffect(() => {
    const player = playerRef.current;
    if (!playerReady || !player || startedRef.current) return;
    startedRef.current = true;
    const { startAt: from, autoPlay: play } = startRef.current;
    const t = Math.max(0, Math.min(from, player.duration || duration));
    if (play) {
      holdThenStart(t >= (player.duration || duration) ? 0 : t);
      return;
    }
    if (t > 0) {
      player.seek(t);
      report(t);
    }
    // Once per mounted version, when it becomes ready: the start position and
    // intent are read from a ref, and holdThenStart is the same routine a click uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerReady]);

  const loading = !playerReady || holding;

  return (
    <div
      data-preview={loading ? "loading" : "ready"}
      data-preview-version={versionId}
      data-version-id={versionId}
      data-intent={intent}
      className="flex min-h-0 w-full flex-1 flex-col gap-2"
    >
      <div className="flex min-h-0 flex-1 justify-center">
        <div
          data-testid="preview-frame"
          className="relative aspect-[9/16] h-full max-h-full max-w-full overflow-hidden rounded-reel bg-black ring-1 ring-line"
        >
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
          {zones && <PlatformZones />}
        </div>
      </div>
      {/* Three columns, the outer two equal: the clock sits on the row's centre
          whatever stands left (Play or Pause) and right (Zones and the extra
          buttons, then Expand or Collapse). Expanded, the right column keeps
          only the expand button. */}
      <div className="grid flex-none grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
        <button
          type="button"
          onClick={onPlayClick}
          disabled={!playerReady}
          aria-label={intent === "playing" ? "Pause" : "Play"}
          title={intent === "playing" ? "Pause" : "Play"}
          data-testid="play-toggle"
          className="flex size-10 items-center justify-start justify-self-start text-ink transition-opacity enabled:hover:opacity-80 disabled:opacity-50"
        >
          {/* A filled play triangle with rounded corners, or two filled bars,
              its left edge on the row's left edge. */}
          <svg
            aria-hidden="true"
            viewBox={intent === "playing" ? PAUSE_VIEWBOX : PLAY_VIEWBOX}
            fill="currentColor"
            className="size-7"
          >
            {intent === "playing" ? (
              <>
                <rect x="6" y="4.5" width="4" height="15" rx="1.25" />
                <rect x="14" y="4.5" width="4" height="15" rx="1.25" />
              </>
            ) : (
              <path
                d="M8 5.6v12.8a1.2 1.2 0 0 0 1.82 1.03l10.4-6.4a1.2 1.2 0 0 0 0-2.06l-10.4-6.4A1.2 1.2 0 0 0 8 5.6Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            )}
          </svg>
        </button>
        {/* Two lines: the current time on top, the total below. The hidden
            slash keeps the read-out "00:00.000 / 00:52.140" for screen readers. */}
        <span
          data-testid="preview-clock"
          className="flex flex-col items-center font-mono text-xs leading-4 whitespace-nowrap tabular-nums"
        >
          <span data-testid="preview-clock-position" className="text-ink">
            {clockText(position)}
          </span>
          <span className="sr-only"> / </span>
          <span data-testid="preview-clock-duration" className="text-muted">
            {clockText(duration)}
          </span>
        </span>
        <div className="flex min-w-0 items-center justify-end gap-2">
          {!expanded && (
            <button
              type="button"
              aria-pressed={zones}
              title="Show what TikTok and Instagram cover"
              onClick={() => setZones((on) => !on)}
              className="flex h-8 flex-none items-center border border-line px-2.5 text-xs hover:bg-raised aria-pressed:bg-raised aria-pressed:font-semibold"
            >
              Zones
            </button>
          )}
          {onExpandedChange && (
            <button
              type="button"
              onClick={() => {
                // Expanding switches Zones off (its button is hidden then);
                // collapsing leaves it off.
                if (!expanded) setZones(false);
                onExpandedChange(!expanded);
              }}
              aria-pressed={expanded}
              aria-label={expanded ? "Collapse preview" : "Expand preview"}
              title={expanded ? "Collapse preview" : "Expand preview"}
              data-testid="preview-expand"
              className="flex size-10 flex-none items-center justify-end text-ink transition-opacity hover:opacity-80"
            >
              {/* Four arrows out to the corners (expand), or in from them
                  (collapse), the right edge on the row's right edge. */}
              <svg
                aria-hidden="true"
                viewBox={EXPAND_VIEWBOX}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-6"
              >
                {expanded ? (
                  <path d="M3 3l6 6m0-4.8V9H4.2M21 3l-6 6m0-4.8V9h4.8M3 21l6-6m0 4.8V15H4.2M21 21l-6-6m0 4.8V15h4.8" />
                ) : (
                  <path d="M9 9 3 3m0 4.8V3h4.8M15 9l6-6m0 4.8V3h-4.8M9 15l-6 6m0-4.8V21h4.8M15 15l6 6m0-4.8V21h-4.8" />
                )}
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
