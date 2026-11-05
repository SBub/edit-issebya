"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { requestRestore } from "@/app/change-actions";
import { versionOrigin, versionTitle } from "@/lib/change-requests";
import type { VersionListRow } from "@/lib/versions";

interface Props {
  reelId: string;
  versions: readonly VersionListRow[];
  currentVersionId: string | null;
  // Null when going back is open; otherwise why not, in one line.
  blockedReason: string | null;
  // A control beside the heading (the temporary Start over button).
  action?: ReactNode;
}

// Every version of the reel, newest first, one row each at one fixed height:
// number, the current mark, a short plain title (up to two lines; the row is
// sized for two whatever the title) and an arrow that opens the row's details
// in place (what the owner asked, what changed, Go back). Going back queues a
// `restore` job: a new version copying the old one, so going back can be
// undone too.
export function VersionList({ reelId, versions, currentVersionId, blockedReason, action }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // The rows opened with their arrow; several may be open at once.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const byId = new Map(versions.map((version) => [version.id, version]));
  const newestFirst = [...versions].sort((a, b) => b.number - a.number);

  function toggle(versionId: string) {
    setExpanded((before) => {
      const next = new Set(before);
      if (!next.delete(versionId)) next.add(versionId);
      return next;
    });
  }

  async function goBack(versionId: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await requestRestore({ reelId, versionId });
      if (result.status === "signed-out") {
        router.refresh();
        return;
      }
      if (result.status === "queued") return;
      setMessage(
        result.status === "failed" ? "Going back did not start. Try again" : result.reason,
      );
    } catch {
      setMessage("Going back did not start. Try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    // No padding of its own around the list: the rows run edge to edge of the
    // Versions area, each with the area's 0.75rem side padding.
    <section
      aria-labelledby="versions-heading"
      aria-describedby="versions-intro"
      className="flex flex-col gap-2 pb-3"
    >
      <div className="flex min-h-7 items-center justify-between gap-2 px-3 pt-3">
        <h2 id="versions-heading" className="text-sm font-semibold">
          Versions
        </h2>
        {action}
      </div>
      {/* Shown with or without versions; an empty list keeps its line below. */}
      <p id="versions-intro" data-testid="versions-intro" className="px-3 text-xs text-muted">
        Your reel&apos;s history. Open a version to see what changed and bring it back
      </p>
      {newestFirst.length === 0 ? (
        <p className="px-3 text-sm text-muted">No version yet</p>
      ) : (
        <ol
          data-testid="version-list"
          className="divide-y divide-line border-y border-line text-sm"
        >
          {newestFirst.map((version) => {
            const current = version.id === currentVersionId;
            const open = expanded.has(version.id);
            const detailsId = `version-details-${version.id}`;
            const title = versionTitle(version, byId);
            return (
              <li
                key={version.id}
                data-testid="version-item"
                data-version-number={version.number}
                data-current={current ? "true" : undefined}
              >
                <div
                  data-testid="version-row"
                  className="flex h-14 items-center gap-3 overflow-hidden pl-3 pr-1"
                >
                  <span className="shrink-0 font-medium">v{version.number}</span>
                  {current && (
                    <span data-testid="version-current" className="shrink-0 text-xs text-accent">
                      current
                    </span>
                  )}
                  <span
                    data-testid="version-title"
                    title={title}
                    className="line-clamp-2 min-w-0 flex-1 break-words"
                  >
                    {title}
                  </span>
                  <button
                    type="button"
                    data-testid="version-toggle"
                    aria-expanded={open}
                    aria-controls={detailsId}
                    aria-label={`Show details of v${version.number}`}
                    title={open ? "Hide details" : "Show details"}
                    onClick={() => toggle(version.id)}
                    className="flex size-8 shrink-0 items-center justify-center text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </button>
                </div>
                <div
                  id={detailsId}
                  data-testid="version-details"
                  hidden={!open}
                  className="flex flex-col gap-1 px-3 pb-3"
                >
                  {version.request && (
                    <h3 className="text-xs font-semibold text-muted">What you asked</h3>
                  )}
                  <p data-testid="version-origin" className="break-words">
                    {versionOrigin(version, byId)}
                  </p>
                  {version.change_summary && !version.restored_from_id && (
                    <>
                      <h3 className="mt-1 text-xs font-semibold text-muted">What changed</h3>
                      <p data-testid="version-summary" className="break-words">
                        {version.change_summary}
                      </p>
                    </>
                  )}
                  {!current && (
                    <button
                      type="button"
                      onClick={() => void goBack(version.id)}
                      disabled={busy || blockedReason !== null}
                      aria-describedby="versions-status"
                      className="mt-1 self-start border border-line px-3 py-1 text-xs hover:bg-raised disabled:opacity-50"
                    >
                      Go back to this
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p id="versions-status" aria-live="polite" className="px-3 text-xs text-muted">
        {message || blockedReason || ""}
      </p>
    </section>
  );
}
