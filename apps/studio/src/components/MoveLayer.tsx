"use client";

import { ISSEBYA_PRESET, type OwnerMove, type PlacedComponent } from "@edit-issebya/edit";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import {
  CLICK_SLOP_PX,
  type Drag,
  boxStyle,
  componentLabel,
  componentOption,
  draggedBox,
  movableAt,
  movableComponents,
  moveOfDrag,
} from "@/lib/owner-edit";

interface Props {
  // Every component of the draft, where the draft has it.
  components: readonly PlacedComponent[];
  // The preview's paused moment: only what shows then can be picked on screen.
  position: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  // A text picked from the list: the preview goes to a moment where it shows.
  onPick: (component: PlacedComponent) => void;
  // A finished drag, before it is made legal.
  onMove: (move: OwnerMove) => void;
  // Whether anything was moved (Save is off until then), and the save's state.
  changed: boolean;
  saving: boolean;
  message: string;
  onSave: () => void;
  onCancel: () => void;
}

interface Pressed extends Drag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  // Frame pixels per screen pixel, read when the press began.
  scale: number;
  dragging: boolean;
}

const FRAME = ISSEBYA_PRESET.frame;

// The move and resize editor over the paused preview (app_docs/owner-edits.md):
// a box around each text component on screen, a bar on top with the list of
// texts, Cancel and Save. Click a box to select it (its kind shows above it),
// drag it to move it, drag its corner handle to resize it. A component has one
// box for its whole time on screen. Nothing here draws the text: after each
// drag the preview is built again from the draft by the one builder. The bar
// sits in the frame's top margin, which the platforms cover, so it never hides
// a text. Never part of the built page or the export.
export function MoveLayer({
  components,
  position,
  selectedId,
  onSelect,
  onPick,
  onMove,
  changed,
  saving,
  message,
  onSave,
  onCancel,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const all = movableComponents(components);
  const shown = movableAt(components, position);

  function press(event: ReactPointerEvent<HTMLElement>, id: string, mode: Drag["mode"]) {
    if (saving || event.button !== 0) return;
    const width = layerRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(id);
    setPressed({
      id,
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scale: FRAME.width / width,
      dx: 0,
      dy: 0,
      dragging: false,
    });
  }

  function drag(event: ReactPointerEvent<HTMLElement>) {
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    // The handle sits inside its box: one press is one drag.
    event.stopPropagation();
    const screenX = event.clientX - pressed.startX;
    const screenY = event.clientY - pressed.startY;
    const dragging = pressed.dragging || Math.hypot(screenX, screenY) >= CLICK_SLOP_PX;
    setPressed({
      ...pressed,
      dragging,
      dx: screenX * pressed.scale,
      dy: screenY * pressed.scale,
    });
  }

  function release(event: ReactPointerEvent<HTMLElement>) {
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    event.stopPropagation();
    setPressed(null);
    if (!pressed.dragging) return;
    const component = components.find((entry) => entry.id === pressed.id);
    const move = component ? moveOfDrag(component, pressed) : null;
    if (move) onMove(move);
  }

  return (
    <div
      ref={layerRef}
      data-testid="move-layer"
      className="absolute inset-0 touch-none select-none"
      onPointerDown={() => {
        if (!saving) onSelect(null);
      }}
    >
      {/* The bar: as tall as the frame's top margin (220 of 1920), which holds no text. */}
      <div
        data-testid="move-bar"
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute inset-x-0 top-0 flex h-[11.4%] min-h-9 items-center gap-1.5 bg-black/75 px-2 text-xs text-white"
      >
        <select
          aria-label="Text to move"
          data-testid="move-pick"
          value={selectedId ?? ""}
          disabled={saving || all.length === 0}
          onChange={(event) => {
            const picked = all.find((entry) => entry.id === event.target.value);
            if (picked) onPick(picked);
            else onSelect(null);
          }}
          className="h-7 min-w-0 flex-1 border border-white/40 bg-black px-1 text-xs text-white disabled:opacity-50"
        >
          <option value="">{all.length === 0 ? "No text to move" : "Pick a text"}</option>
          {all.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {componentOption(entry)}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="move-cancel"
          onClick={onCancel}
          disabled={saving}
          className="h-7 flex-none border border-white/40 px-2 hover:bg-white/15 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="move-save"
          onClick={onSave}
          disabled={saving || !changed}
          title={changed ? "Save as a new version" : "Move or resize a text first"}
          className="h-7 flex-none border border-white bg-white px-2 font-semibold text-black hover:bg-white/85 disabled:opacity-50"
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>
      {shown.map((component) => {
        const selected = component.id === selectedId;
        const active = pressed?.id === component.id && pressed.dragging ? pressed : null;
        const label = componentLabel(component.component);
        return (
          <div
            key={component.id}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${label}: ${component.text}`}
            data-testid="move-box"
            data-component-id={component.id}
            data-component={component.component}
            data-selected={selected ? "true" : undefined}
            onPointerDown={(event) => press(event, component.id, "move")}
            onPointerMove={drag}
            onPointerUp={release}
            onPointerCancel={() => setPressed(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(component.id);
              }
            }}
            className={`absolute outline-offset-2 focus-visible:outline-2 ${
              selected
                ? "cursor-move outline outline-2 outline-accent"
                : "cursor-pointer outline-dashed outline-1 outline-white/80 hover:outline-2 hover:outline-white"
            }`}
            style={boxStyle(draggedBox(component, active), FRAME)}
          >
            {selected && (
              <>
                <span
                  data-testid="move-kind"
                  className="absolute bottom-full left-0 mb-1 -ml-0.5 bg-accent px-1.5 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap text-black"
                >
                  {label}
                </span>
                <span
                  role="button"
                  aria-label={`Resize ${label.toLowerCase()}`}
                  title="Drag to resize"
                  data-testid="move-handle"
                  onPointerDown={(event) => press(event, component.id, "resize")}
                  onPointerMove={drag}
                  onPointerUp={release}
                  onPointerCancel={() => setPressed(null)}
                  className="absolute -right-2.5 -bottom-2.5 size-4 cursor-nwse-resize border-2 border-white bg-accent"
                />
              </>
            )}
          </div>
        );
      })}
      <p
        role="status"
        data-testid="move-status"
        className="pointer-events-none absolute inset-x-0 bottom-2 px-2 text-center text-xs font-medium text-white empty:hidden"
      >
        {message}
      </p>
    </div>
  );
}
