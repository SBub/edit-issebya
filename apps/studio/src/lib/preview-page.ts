import type { BuildAsset } from "@edit-issebya/edit";
import { editAssetUrl } from "./edit-assets";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// The builder's attribute escaping, so a path matches the bytes it wrote and
// a signed URL (with its `&`) stays one attribute value.
function escapeAttr(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

// The page the player is handed, from the page packages/edit built: each
// footage video's file (the cut-out's footage copies included) becomes its
// preview copy's signed URL, each mask video's file its signed URL (both
// buffer ahead), each font and each visual's picture comes from the edit-assets
// route, and the sound items' `<audio>` clips are dropped (the studio plays
// them through Web Audio). Nothing else changes. Throws when the page is not shaped the way the builder
// writes it, or a mask has no URL.
export function previewPage(
  html: string,
  assets: readonly BuildAsset[],
  urls: {
    footage: string;
    masks?: readonly { path: string; url: string }[];
  },
  soundIds: readonly string[],
): string {
  let lines = html.split("\n");

  // Every `<tag ` line playing `path` gets `url` (and `extra`); none throws.
  const swap = (tag: string, path: string, url: string, extra: string) => {
    const from = ` src="${escapeAttr(path)}"`;
    const to = ` src="${escapeAttr(url)}"${extra}`;
    let found = false;
    lines = lines.map((line) => {
      if (!line.trimStart().startsWith(`<${tag} `) || !line.includes(from)) return line;
      found = true;
      return line.replace(from, to);
    });
    if (!found) throw new Error(`preview: no <${tag}> plays ${path}`);
  };
  const urlOf = (list: readonly { path: string; url: string }[] | undefined, path: string) => {
    const url = list?.find((entry) => entry.path === path)?.url;
    if (!url) throw new Error(`preview: no URL for ${path}`);
    return url;
  };

  for (const asset of assets) {
    if (asset.role === "footage") {
      swap("video", asset.path, urls.footage, ' preload="auto"');
    } else if (asset.role === "mask") {
      swap("video", asset.path, urlOf(urls.masks, asset.path), ' preload="auto"');
    } else if (asset.role === "visual") {
      swap("img", asset.path, editAssetUrl(asset.path), "");
    } else if (asset.role === "font") {
      const from = `url("${asset.path}")`;
      const to = `url("${editAssetUrl(asset.path)}")`;
      let found = false;
      lines = lines.map((line) => {
        if (!line.trimStart().startsWith("@font-face ") || !line.includes(from)) return line;
        found = true;
        return line.replace(from, to);
      });
      if (!found) throw new Error(`preview: no @font-face loads ${asset.path}`);
    }
  }

  for (const id of soundIds) {
    const start = `<audio id="${escapeAttr(id)}" `;
    const before = lines.length;
    lines = lines.filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith(start) && trimmed.endsWith("></audio>"));
    });
    if (lines.length !== before - 1) throw new Error(`preview: no single <audio> for ${id}`);
  }

  return lines.join("\n");
}
