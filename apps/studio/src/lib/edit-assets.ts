import { FONT_KEYS, ISSEBYA_PRESET, type Preset } from "@edit-issebya/edit";

// The route the preset's fonts and sounds are served from (they ship with
// packages/edit, not R2).
const EDIT_ASSETS_BASE = "/studio/api/edit-assets/";

// Every file the preset names (relative to packages/edit, as the built page
// writes them), with its content type. Nothing else is ever served.
function editAssetFiles(preset: Preset = ISSEBYA_PRESET): Map<string, string> {
  const files = new Map<string, string>();
  for (const key of FONT_KEYS) files.set(preset.fonts[key].file, "font/ttf");
  for (const sound of Object.values(preset.sounds)) files.set(sound.file, "audio/wav");
  return files;
}

export const EDIT_ASSET_FILES = editAssetFiles();

// The URL the browser fetches a preset path from.
export function editAssetUrl(path: string): string {
  if (!EDIT_ASSET_FILES.has(path)) throw new Error(`not a preset asset: ${path}`);
  return `${EDIT_ASSETS_BASE}${path}`;
}
