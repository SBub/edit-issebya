"use client";

import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

const TABS = [
  { key: "edit", label: "Edit" },
  { key: "versions", label: "Versions" },
  { key: "library", label: "Library" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

interface Props {
  header: ReactNode;
  // The preview, its controls and the tracks timeline.
  main: ReactNode;
  // Pinned under the middle on every size: the correction field.
  footer: ReactNode;
  // The side panel over the full height (desktop), the phone's Versions tab.
  versions: ReactNode;
  // The owner's photo library: a third column on desktop, the phone's
  // Library tab.
  library: ReactNode;
}

// The reel page on one screen, with no JavaScript measuring the window: the
// root is exactly the height it is given, every child that can grow is
// `min-h-0`, and only the list areas scroll (inside their own box).
//
// Desktop (`lg:`): the header; a main column (preview with its progress
// overlay, controls, timeline) with the correction field pinned under it; a
// side panel with Versions over the full height; the photo library as a third
// column over the full height. Phone: the same header and pinned footer, the
// middle split into three tabs (Edit, Versions, Library), one shown.
export function ReelScreen({ header, main, footer, versions, library }: Props) {
  const [tab, setTab] = useState<TabKey>("edit");
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    edit: null,
    versions: null,
    library: null,
  });

  // WAI-ARIA tabs: arrows, Home and End move the selection and the focus.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((entry) => entry.key === tab);
    const moves: Record<string, number> = {
      ArrowRight: (index + 1) % TABS.length,
      ArrowLeft: (index - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const key = TABS[next]!.key;
    setTab(key);
    tabRefs.current[key]?.focus();
  }

  // Below `lg` only the selected panel shows; at `lg` every panel does.
  const shown = (key: TabKey) => (tab === key ? "flex" : "hidden lg:flex");
  const panel = (key: TabKey) => ({
    id: `reel-panel-${key}`,
    role: "tabpanel",
    "aria-labelledby": `reel-tab-${key}`,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-none items-center gap-3 border-b border-line bg-panel px-3 py-2 lg:px-5">
        {header}
      </header>
      <div
        role="tablist"
        aria-label="Reel"
        onKeyDown={onKeyDown}
        className="flex flex-none border-b border-line bg-panel lg:hidden"
      >
        {TABS.map((entry) => (
          <button
            key={entry.key}
            ref={(el) => {
              tabRefs.current[entry.key] = el;
            }}
            type="button"
            role="tab"
            id={`reel-tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`reel-panel-${entry.key}`}
            tabIndex={tab === entry.key ? 0 : -1}
            onClick={() => setTab(entry.key)}
            className={`flex-1 border-b-2 px-3 py-2 text-sm font-medium ${
              tab === entry.key ? "border-accent text-ink" : "border-transparent text-muted"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_20rem_18rem] lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_24rem_22rem]">
        <div
          {...panel("edit")}
          data-testid="edit-area"
          className={`${shown("edit")} min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:px-5`}
        >
          {main}
        </div>
        <div className="order-last flex-none border-t border-line bg-panel px-3 py-2 lg:order-none lg:col-start-1 lg:row-start-3 lg:px-5">
          {footer}
        </div>
        <div
          {...panel("versions")}
          data-testid="versions-area"
          className={`${shown("versions")} min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:border-l lg:border-line`}
        >
          {versions}
        </div>
        <div
          {...panel("library")}
          data-testid="library-area"
          className={`${shown("library")} min-h-0 flex-1 flex-col overflow-hidden lg:col-start-3 lg:row-span-3 lg:row-start-1 lg:border-l lg:border-line`}
        >
          {library}
        </div>
      </div>
    </div>
  );
}
