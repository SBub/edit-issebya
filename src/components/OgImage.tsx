import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { LANDING } from "@/content/landing";
import { REELS } from "@/content/reels";

// The link preview shared by opengraph-image.tsx and twitter-image.tsx: the
// wordmark, the first sentence of the introduction and the reel posters as
// 9:16 thumbnails. White page, neutral-900 text, one fuchsia-700 rule.
export const OG_IMAGE_SIZE = { width: 1200, height: 630 };
export const OG_IMAGE_ALT =
  "edit issebya: your ideas deserve reels that look like your brand. Three edited reel posters.";

const POSTER = { width: 214, height: 380 };

// "Your ideas deserve reels that look like your brand", no full stop.
const HEADLINE = LANDING.quote.split(".")[0];

// The posters, read from public/ and inlined: the image renders without a
// request back to the site.
async function posterDataUrls(): Promise<string[]> {
  const posters = REELS.flatMap((reel) => (reel.poster ? [reel.poster] : [])).slice(0, 3);
  return Promise.all(
    posters.map(async (src) => {
      // The path comes from the REELS constant, never from a request.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const data = await readFile(join(process.cwd(), "public", src));
      return `data:image/jpeg;base64,${data.toString("base64")}`;
    }),
  );
}

export async function renderOgImage(): Promise<ImageResponse> {
  const posters = await posterDataUrls();
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "64px",
        background: "#ffffff",
        color: "#171717",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          height: "100%",
          width: "380px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <span style={{ fontSize: 64, fontWeight: 600, letterSpacing: "-0.025em" }}>
            {LANDING.brand.name}
          </span>
          <span style={{ fontSize: 30, marginLeft: 4, position: "relative", top: 10 }}>
            {LANDING.brand.suffix}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ width: 56, height: 6, background: "#a21caf", marginBottom: 28 }} />
          <div style={{ fontSize: 46, lineHeight: 1.2 }}>{HEADLINE}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        {posters.map((src) => (
          // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
          <img
            key={src.slice(-32)}
            src={src}
            width={POSTER.width}
            height={POSTER.height}
            style={{ borderRadius: 16, objectFit: "cover" }}
          />
        ))}
      </div>
    </div>,
    { ...OG_IMAGE_SIZE },
  );
}
