"use client";

import type { OverlayState } from "@/lib/progress-overlay";

interface Props {
  state: OverlayState;
  onTryAgain: () => void;
  onChangeRequest: () => void;
  onKeep: () => void;
  // Try again's answer ("Queued again.", say); empty while none.
  actionMessage: string;
  // True while Try again is being sent or once it queued the job.
  tryAgainBusy: boolean;
}

const BUTTON =
  "pointer-events-auto rounded-full border border-line bg-raised px-3 py-1 text-xs font-medium text-ink hover:bg-line disabled:opacity-60";

// The small card over the top of the preview (app_docs/status.md): what the
// studio is doing in plain words, how far along, the waiting lines, the new
// version notice, or a failure with the actions that fit. It never blocks the
// player: the card takes no pointer events, only its own buttons do. The words
// sit in a polite live region; the buttons stay outside it, so they are not
// announced again on each update.
export function ProgressOverlay({
  state,
  onTryAgain,
  onChangeRequest,
  onKeep,
  actionMessage,
  tryAgainBusy,
}: Props) {
  if (state.kind === "hidden") return null;
  return (
    <div
      data-testid="progress-overlay"
      data-overlay-kind={state.kind}
      className="pointer-events-none absolute top-2 right-2 left-2 z-10 flex flex-col gap-2 rounded-xl border border-line bg-panel/90 px-3 py-2 text-sm shadow-lg backdrop-blur-sm sm:right-auto sm:max-w-xs"
    >
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {state.kind === "notice" && (
          <p data-testid="overlay-notice" className="font-medium">
            {state.text}
          </p>
        )}
        {state.kind === "working" && (
          <>
            <p data-testid="overlay-words" className="font-medium">
              {state.words}
            </p>
            {state.total > 0 && state.index > 0 && (
              <p data-testid="overlay-step" className="text-xs text-muted">
                Step {state.index} of {state.total}
              </p>
            )}
            <div
              role="progressbar"
              aria-label="Progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(state.fraction * 100)}
              className="h-1.5 overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${Math.round(state.fraction * 100)}%` }}
              />
            </div>
            {state.percent !== null && (
              <p className="flex flex-wrap gap-3 text-xs">
                <span data-testid="step-progress">{state.percent}%</span>
                <span data-testid="step-time-left" className="text-muted">
                  {state.timeLeft}
                </span>
              </p>
            )}
            {state.waitingAi && (
              <p data-testid="job-waiting-ai" className="text-xs text-warn">
                {state.waitingAi}
              </p>
            )}
            {state.waitingDisk && (
              <p data-testid="job-waiting" className="text-xs text-warn">
                {state.waitingDisk}
              </p>
            )}
            {state.offline && (
              <p data-testid="job-offline" className="text-xs text-warn">
                {state.offline}
              </p>
            )}
          </>
        )}
        {state.kind === "failure" && (
          <>
            <p data-testid="overlay-headline" className="font-medium text-danger">
              {state.headline}
            </p>
            {state.reason && (
              <p data-testid="overlay-reason" className="text-xs">
                {state.reason}
              </p>
            )}
            {actionMessage && (
              <p data-testid="overlay-action-message" className="text-xs text-muted">
                {actionMessage}
              </p>
            )}
          </>
        )}
      </div>
      {state.kind === "failure" && (
        <div className="flex flex-wrap gap-2">
          {state.actions.includes("try_again") && (
            <button
              type="button"
              data-testid="overlay-try-again"
              onClick={onTryAgain}
              disabled={tryAgainBusy}
              className={BUTTON}
            >
              Try again
            </button>
          )}
          {state.actions.includes("change_request") && (
            <button
              type="button"
              data-testid="overlay-change-request"
              onClick={onChangeRequest}
              className={BUTTON}
            >
              Change the request
            </button>
          )}
          {state.actions.includes("keep_current") && (
            <button type="button" data-testid="overlay-keep" onClick={onKeep} className={BUTTON}>
              Keep the current version
            </button>
          )}
        </div>
      )}
    </div>
  );
}
