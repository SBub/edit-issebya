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
// video's file becomes its preview copy's signed URL (and buffers ahead), each
// font comes from the edit-assets route, and the sound items' `<audio>` clips
// are dropped (the studio plays them through Web Audio). Nothing else
// changes. Throws when the page is not shaped the way the builder writes it.
export function previewPage(
  html: string,
  assets: readonly BuildAsset[],
  urls: { footage: string; cutout: string },
  soundIds: readonly string[],
): string {
  let lines = html.split("\n");

  for (const asset of assets) {
    if (asset.role === "footage" || asset.role === "cutout") {
      const from = ` src="${escapeAttr(asset.path)}"`;
      const to = ` src="${escapeAttr(urls[asset.role])}" preload="auto"`;
      let found = false;
      lines = lines.map((line) => {
        if (!line.trimStart().startsWith("<video ") || !line.includes(from)) return line;
        found = true;
        return line.replace(from, to);
      });
      if (!found) throw new Error(`preview: no <video> plays ${asset.path}`);
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
