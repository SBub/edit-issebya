// The asset list as the builder returns it (`BuildAsset` in @edit-issebya/edit).
interface PageAsset {
  role: "footage" | "cutout" | "font" | "sound";
  path: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// The copy of the built page the player gets: every listed asset path
// replaced by its URL (`src="<path>"` and `url("<path>")` only), and every
// `<audio>` line of a sound asset removed, since the preview plays the sounds
// track through Web Audio (left in, the player would play each click a second
// time). Nothing else changes: not the GSAP script, not the timeline. An
// asset without a URL throws.
export function previewPage(
  html: string,
  assets: PageAsset[],
  urls: Record<string, string>,
): string {
  let page = html;
  for (const asset of assets) {
    if (asset.role !== "sound") continue;
    const path = escapeRegExp(asset.path);
    // eslint-disable-next-line security/detect-non-literal-regexp -- built from an escaped asset path
    const line = new RegExp(`\\n[ \\t]*<audio [^\\n]*src="${path}"[^\\n]*</audio>(?=\\n)`, "g");
    page = page.replace(line, "");
  }
  for (const asset of assets) {
    if (asset.role === "sound") continue;
    const url = urls[asset.path];
    if (!url) throw new Error(`no URL for ${asset.path}`);
    const path = escapeRegExp(asset.path);
    page = page
      // eslint-disable-next-line security/detect-non-literal-regexp -- built from an escaped asset path
      .replace(new RegExp(`src="${path}"`, "g"), () => `src="${escapeAttribute(url)}"`)
      // eslint-disable-next-line security/detect-non-literal-regexp -- built from an escaped asset path
      .replace(new RegExp(`url\\("${path}"\\)`, "g"), () => `url("${url.replace(/"/g, "%22")}")`);
  }
  return page;
}
