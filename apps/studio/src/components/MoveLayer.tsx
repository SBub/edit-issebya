"use client";

import { ISSEBYA_PRESET, type PlacedComponent } from "@edit-issebya/edit";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import {
  CLICK_SLOP_PX,
  type Drag,
  EDGE_MODES,
  type EdgeMode,
  type OwnerAsk,
  SNAP_PX,
  boxStyle,
  canRewrap,
  componentLabel,
  componentOption,
  draggedBox,
  draggedTurn,
  movableComponents,
  moveOfDrag,
  snapAngle,
  snapDrag,
  stackedAt,
  turnOfPointer,
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
  // A finished drag, before its lines are chosen and it is made legal.
  onMove: (ask: OwnerAsk) => void;
  // Every frame of a drag, in frame pixels (snapped), so the page on screen
  // shows the component there at once; null when a drag is cancelled.
  onDragFrame: (component: PlacedComponent, drag: Drag | null) => void;
  // Whether anything was moved (Save is off until then), and the save's state.
  changed: boolean;
  saving: boolean;
  message: string;
  onSave: () => void;
  onCancel: () => void;
  // The selected card's picture swapped for a library photo (the picker opens).
  onChangePicture: (component: PlacedComponent) => void;
  // A new card added at the paused moment (the picker opens); `canAdd` is
  // false where no card can show (hidden footage, the reel's very end).
  onAddPicture: () => void;
  canAdd: boolean;
}

interface Pressed extends Drag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  // Frame pixels per screen pixel, read when the press began.
  scale: number;
  dragging: boolean;
  // Which centre line the dragged box's centre is snapped to.
  snapped: { x: boolean; y: boolean };
  // A rotate handle's press: the box's centre on screen and the card's turn
  // when it began; `turnSnapped` while the turn sits on a quarter turn.
  centre: { x: number; y: number };
  from: number;
  turnSnapped: boolean;
}

const FRAME = ISSEBYA_PRESET.frame;

// Each edge handle: where it sits on the selected box, its cursor and its name.
const EDGES: Record<EdgeMode, { className: string; label: string }> = {
  left: {
    className: "top-1/2 -left-1.5 h-5 w-2 -translate-y-1/2 cursor-ew-resize",
    label: "Make narrower or wider from the left",
  },
  right: {
    className: "top-1/2 -right-1.5 h-5 w-2 -translate-y-1/2 cursor-ew-resize",
    label: "Make narrower or wider from the right",
  },
  top: {
    className: "-top-1.5 left-1/2 h-2 w-5 -translate-x-1/2 cursor-ns-resize",
    label: "Make shorter or taller from the top",
  },
  bottom: {
    className: "-bottom-1.5 left-1/2 h-2 w-5 -translate-x-1/2 cursor-ns-resize",
    label: "Make shorter or taller from the bottom",
  },
};

// The move and resize editor over the paused preview (app_docs/owner-edits.md):
// a box around each text component and VISUAL on screen, a bar on top with the
// list of them, Cancel and Save. Click a box to select it (its kind shows above it),
// drag it to move it (its centre snaps to the frame's centre lines, and a thin
// guide shows while it is on one), drag its corner handle to resize it in
// proportion (the text size), drag an edge handle to make the box wider,
// narrower, taller or shorter at the same text size (its lines set again; a
// VISUAL has no edge handle, its corner keeps its picture's aspect ratio; its
// rotate handle above the box turns it about its centre, snapping upright and
// to each quarter turn with a guide and its angle shown). A component has one
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
  onDragFrame,
  changed,
  saving,
  message,
  onSave,
  onCancel,
  onChangePicture,
  onAddPicture,
  canAdd,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const all = movableComponents(components);
  const shown = stackedAt(components, position);
  const selectedCard = components.find(
    (entry) => entry.id === selectedId && entry.component === "VISUAL",
  );

  function press(event: ReactPointerEvent<HTMLElement>, id: string, mode: Drag["mode"]) {
    if (saving || event.button !== 0) return;
    const rect = layerRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    if (!rect || width <= 0) return;
    const component = components.find((entry) => entry.id === id);
    const perFrame = width / FRAME.width;
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
      snapped: { x: false, y: false },
      centre: component
        ? {
            x: rect.left + (component.x + component.width / 2) * perFrame,
            y: rect.top + (component.y + component.height / 2) * perFrame,
          }
        : { x: 0, y: 0 },
      from: component?.rotation ?? 0,
      turnSnapped: false,
    });
  }

  function drag(event: ReactPointerEvent<HTMLElement>) {
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    // The handle sits inside its box: one press is one drag.
    event.stopPropagation();
    const screenX = event.clientX - pressed.startX;
    const screenY = event.clientY - pressed.startY;
    const dragging = pressed.dragging || Math.hypot(screenX, screenY) >= CLICK_SLOP_PX;
    const component = components.find((entry) => entry.id === pressed.id);
    if (pressed.mode === "rotate") {
      // The card turns with the pointer round its centre, snapping upright and
      // to each quarter turn.
      const turn = snapAngle(
        turnOfPointer(
          pressed.centre,
          { x: pressed.startX, y: pressed.startY },
          { x: event.clientX, y: event.clientY },
          pressed.from,
        ),
      );
      setPressed({
        ...pressed,
        dragging,
        angle: turn.angle,
        turnSnapped: dragging && turn.snapped,
      });
      if (dragging && component) {
        onDragFrame(component, { mode: "rotate", dx: 0, dy: 0, angle: turn.angle });
      }
      return;
    }
    const raw = { ...pressed, dragging, dx: screenX * pressed.scale, dy: screenY * pressed.scale };
    // The box's centre gravitates to the frame's centre lines.
    const { drag: snapped, snapped: on } = component
      ? snapDrag(component, raw, FRAME, SNAP_PX * pressed.scale)
      : { drag: raw, snapped: { x: false, y: false } };
    setPressed({ ...snapped, snapped: dragging ? on : { x: false, y: false } });
    if (dragging && component) {
      onDragFrame(component, { mode: snapped.mode, dx: snapped.dx, dy: snapped.dy });
    }
  }

  function cancel() {
    const component = pressed && components.find((entry) => entry.id === pressed.id);
    if (component && pressed.dragging) onDragFrame(component, null);
    setPressed(null);
  }

  function release(event: ReactPointerEvent<HTMLElement>) {
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    event.stopPropagation();
    setPressed(null);
    if (!pressed.dragging) return;
    const component = components.find((entry) => entry.id === pressed.id);
    const move = component ? moveOfDrag(component, pressed) : null;
    if (move) onMove(move);
    else if (component) onDragFrame(component, null);
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
          aria-label="Text or visual to move"
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
          <option value="">{all.length === 0 ? "Nothing to move" : "Pick a text or visual"}</option>
          {all.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {componentOption(entry)}
            </option>
          ))}
        </select>
        {selectedCard ? (
          <button
            type="button"
            data-testid="move-change-picture"
            onClick={() => onChangePicture(selectedCard)}
            disabled={saving}
            title="Show a photo from your library on this card"
            className="h-7 flex-none border border-white/40 px-2 hover:bg-white/15 disabled:opacity-50"
          >
            Change picture
          </button>
        ) : (
          selectedId === null && (
            <button
              type="button"
              data-testid="move-add-picture"
              onClick={onAddPicture}
              disabled={saving || !canAdd}
              title={
                canAdd
                  ? "Add a photo from your library at this moment"
                  : "No picture can show here: the footage is hidden"
              }
              className="h-7 flex-none border border-white/40 px-2 hover:bg-white/15 disabled:opacity-50"
            >
              Add picture here
            </button>
          )
        )}
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
      {/* The centre guides: a thin line while the dragged box's centre is on it. */}
      {pressed?.dragging && pressed.snapped.x && (
        <div
          data-testid="move-guide"
          data-axis="vertical"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-accent"
        />
      )}
      {pressed?.dragging && pressed.snapped.y && (
        <div
          data-testid="move-guide"
          data-axis="horizontal"
          className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-accent"
        />
      )}
      {/* The turn's hint: its angle at the card's centre, and a guide through
          the centre while it sits upright or on a quarter turn. */}
      {pressed?.dragging &&
        pressed.mode === "rotate" &&
        (() => {
          const component = components.find((entry) => entry.id === pressed.id);
          if (!component) return null;
          const centre = {
            left: `${((component.x + component.width / 2) / FRAME.width) * 100}%`,
            top: `${((component.y + component.height / 2) / FRAME.height) * 100}%`,
          };
          return (
            <>
              {pressed.turnSnapped && (
                <>
                  <div
                    data-testid="move-turn-guide"
                    data-axis="horizontal"
                    style={{ top: centre.top }}
                    className="pointer-events-none absolute inset-x-0 h-px -translate-y-1/2 bg-accent"
                  />
                  <div
                    data-testid="move-turn-guide"
                    data-axis="vertical"
                    style={{ left: centre.left }}
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-accent"
                  />
                </>
              )}
              <span
                data-testid="move-angle"
                data-snapped={pressed.turnSnapped ? "true" : undefined}
                style={centre}
                className={`pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap ${
                  pressed.turnSnapped ? "bg-accent text-black" : "bg-black/75 text-white"
                }`}
              >
                {draggedTurn(component, pressed)}°
              </span>
            </>
          );
        })()}
      {shown.map((component) => {
        const selected = component.id === selectedId;
        const active = pressed?.id === component.id && pressed.dragging ? pressed : null;
        const label = componentLabel(component.component);
        const turn = draggedTurn(component, active);
        const visual = component.component === "VISUAL";
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
            data-rotation={visual ? turn : undefined}
            onPointerDown={(event) => press(event, component.id, "move")}
            onPointerMove={drag}
            onPointerUp={release}
            onPointerCancel={cancel}
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
            style={{
              ...boxStyle(draggedBox(component, active), FRAME),
              // A turned card's box turns with it, about its centre.
              ...(turn !== 0 ? { rotate: `${turn}deg` } : {}),
            }}
          >
            {selected && (
              <>
                <span
                  data-testid="move-kind"
                  className={`absolute left-0 -ml-0.5 bg-accent px-1.5 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap text-black ${
                    // A card's rotate handle is above it: its kind shows below.
                    visual ? "top-full mt-1" : "bottom-full mb-1"
                  }`}
                >
                  {label}
                </span>
                {visual && (
                  <>
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -top-5 left-1/2 h-5 w-px -translate-x-1/2 bg-accent"
                    />
                    <span
                      role="button"
                      aria-label={`Rotate ${label.toLowerCase()}`}
                      title="Drag to rotate"
                      data-testid="move-rotate"
                      onPointerDown={(event) => press(event, component.id, "rotate")}
                      onPointerMove={drag}
                      onPointerUp={release}
                      onPointerCancel={cancel}
                      className="absolute -top-7 left-1/2 size-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-white bg-accent active:cursor-grabbing"
                    />
                  </>
                )}
                <span
                  role="button"
                  aria-label={`Resize ${label.toLowerCase()}`}
                  title="Drag to resize"
                  data-testid="move-handle"
                  onPointerDown={(event) => press(event, component.id, "resize")}
                  onPointerMove={drag}
                  onPointerUp={release}
                  onPointerCancel={cancel}
                  className="absolute -right-2.5 -bottom-2.5 size-4 cursor-nwse-resize border-2 border-white bg-accent"
                />
                {canRewrap(component) &&
                  EDGE_MODES.map((edge) => (
                    <span
                      key={edge}
                      role="button"
                      aria-label={EDGES[edge].label}
                      title={EDGES[edge].label}
                      data-testid="move-edge"
                      data-edge={edge}
                      onPointerDown={(event) => press(event, component.id, edge)}
                      onPointerMove={drag}
                      onPointerUp={release}
                      onPointerCancel={cancel}
                      className={`absolute border border-white bg-accent ${EDGES[edge].className}`}
                    />
                  ))}
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
