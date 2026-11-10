"use client";

import { FONT_PAIR_IDS, FONT_PAIRS, type FontPairId } from "@edit-issebya/edit";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { requestFontPair } from "@/app/change-actions";
import { faceStyle, loadFontPairFaces } from "@/lib/font-pair-faces";
import type { JobRow } from "@/lib/jobs";

interface Props {
  reelId: string;
  // The owner's pair (their profile): the one shown as chosen until a pick.
  fontPair: FontPairId;
  // Null when a pair can be picked; otherwise why not (the reel is blocked).
  blockedReason: string | null;
  // The queue note (`Waiting: ...`) while any job of the reel is live.
  queueNote: string | null;
  // The reel's jobs, so the picker stays off until its own job ends.
  jobs: readonly Pick<JobRow, "id" | "status">[];
  hasVersion: boolean;
}

const LIVE: readonly JobRow["status"][] = ["queued", "running", "waiting_ai"];
const FAILED = "Font pair did not change. Try again";

// The tool panel above the versions list: the six font pairs, each shown as a
// sample written in its own two fonts. Picking one saves it to the owner's
// profile and queues a `relayout` job for this reel; the new version appears
// in the list like any other. Off while the reel is blocked, has no version,
// or a job of it is live (the same rule as Start over).
export function FontPairPicker({
  reelId,
  fontPair,
  blockedReason,
  queueNote,
  jobs,
  hasVersion,
}: Props) {
  const router = useRouter();
  // The pair picked on this page, until the profile's pair is read again.
  const [picked, setPicked] = useState<FontPairId | null>(null);
  const current = picked ?? fontPair;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // The job sent, until it shows in the live jobs and ends.
  const [sentId, setSentId] = useState<string | null>(null);
  const [faces, setFaces] = useState(false);
  const sentJob = sentId ? jobs.find((job) => job.id === sentId) : undefined;
  const pending = sentId !== null && (!sentJob || LIVE.includes(sentJob.status));
  const disabled = busy || pending || !hasVersion || blockedReason !== null || queueNote !== null;

  // The samples show in their own fonts once they are registered.
  useEffect(() => {
    let alive = true;
    Promise.all(FONT_PAIR_IDS.map((id) => loadFontPairFaces(FONT_PAIRS[id])))
      .then(() => {
        if (alive) setFaces(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function choose(id: FontPairId) {
    if (disabled || id === current) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await requestFontPair({ reelId, fontPair: id });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") {
        setPicked(id);
        setSentId(result.jobId);
        return;
      }
      setMessage(result.status === "failed" ? FAILED : result.reason);
    } catch {
      setMessage(FAILED);
    } finally {
      setBusy(false);
    }
  }

  const offTitle = blockedReason ?? queueNote ?? "Place this reel again in another font pair";

  return (
    <section
      aria-labelledby="font-pair-heading"
      aria-describedby="font-pair-intro"
      data-testid="font-pair-picker"
      className="flex max-h-[50%] flex-none flex-col gap-2 overflow-y-auto border-b border-line px-3 py-3"
    >
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 id="font-pair-heading" className="text-sm font-semibold">
          Font pair
        </h2>
        <span
          data-testid="font-pair-status"
          aria-live="polite"
          className="min-w-0 truncate text-xs text-muted empty:hidden"
        >
          {message}
        </span>
      </div>
      <p id="font-pair-intro" className="text-xs text-muted">
        Your words in the simple font, accents in the artistic one. Picking a pair places this reel
        again as a new version.
      </p>
      <div role="radiogroup" aria-label="Font pair" className="grid gap-1.5">
        {FONT_PAIR_IDS.map((id) => {
          const pair = FONT_PAIRS[id];
          const selected = id === current;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`font-pair-${id}`}
              data-selected={selected}
              disabled={disabled && !selected}
              onClick={() => void choose(id)}
              title={disabled ? offTitle : `${pair.label}: ${pair.standsInFor}`}
              className={`flex flex-col gap-0.5 border px-2.5 py-1.5 text-left disabled:opacity-50 ${
                selected ? "border-accent bg-raised" : "border-line hover:bg-raised"
              }`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold">{pair.label}</span>
                <span className="truncate text-[0.7rem] text-muted">{pair.standsInFor}</span>
              </span>
              <span
                data-testid={`font-pair-sample-${id}`}
                data-faces={faces ? "ready" : "loading"}
                className="flex items-baseline gap-2 text-lg leading-tight text-ink"
              >
                <span style={faceStyle(pair.simple)}>Your words</span>
                <span style={faceStyle(pair.artistic)}>with style</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
