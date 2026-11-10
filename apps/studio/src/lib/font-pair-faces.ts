import {
  DEFAULT_FONT_PAIR_ID,
  FONT_ROLES,
  type FontPair,
  type FontPairId,
  type FontRole,
  type PresetFont,
  isFontPairId,
} from "@edit-issebya/edit";
import type { CSSProperties } from "react";
import { editAssetUrl } from "@/lib/edit-assets";

// The CSS a sample set in one font draws with: its family, weight and style.
export function faceStyle(font: PresetFont): CSSProperties {
  return { fontFamily: `"${font.family}"`, fontWeight: font.weight, fontStyle: font.style };
}

// The pair a profile row names; no row, or a name outside the six, is the
// classic pair (the worker reads the same rule: `apps/worker/src/font-pair-store.ts`).
export function pairOfProfile(row: { font_pair?: unknown } | null | undefined): FontPairId {
  return isFontPairId(row?.font_pair) ? row.font_pair : DEFAULT_FONT_PAIR_ID;
}

const registered = new Map<FontPairId, Promise<void>>();

// Registers both faces of a pair with the document, once per page load, from
// the edit-assets route. A failed load is tried again on the next call.
export function loadFontPairFaces(pair: FontPair): Promise<void> {
  let entry = registered.get(pair.id);
  if (!entry) {
    entry = Promise.all(
      FONT_ROLES.map(async (role: FontRole) => {
        const font = pair[role];
        const face = new FontFace(font.family, `url(${editAssetUrl(font.file)})`, {
          weight: String(font.weight),
          style: font.style,
        });
        document.fonts.add(face);
        await face.load();
      }),
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        registered.delete(pair.id);
        throw error;
      });
    registered.set(pair.id, entry);
  }
  return entry;
}
