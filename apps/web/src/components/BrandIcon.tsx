import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { LANDING } from "@/content/landing";

// The favicon and Apple touch icon: the page header's wordmark ("edit" in
// semibold with "issebya" set small and low on its right, like BrandName),
// black on white, centred in a square and as large as fits the width.
// Geist (SIL Open Font License, assets/fonts) because the image renderer
// only ships a regular weight.

// The wordmark is about 3.6 times as wide as its font size, so a font size of
// a quarter of the square fills about 90% of its width.
const FONT_SIZE_RATIO = 0.25;

async function font(file: string): Promise<Buffer> {
  // The file name is one of two literals below, never from a request.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFile(join(process.cwd(), "assets/fonts", file));
}

export async function renderBrandIcon(sizePx: number): Promise<ImageResponse> {
  const [semibold, regular] = await Promise.all([
    font("Geist-SemiBold.ttf"),
    font("Geist-Regular.ttf"),
  ]);
  const fontSize = sizePx * FONT_SIZE_RATIO;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
        color: "#171717",
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", lineHeight: 1 }}>
        <span style={{ fontSize, fontWeight: 600, letterSpacing: "-0.025em" }}>
          {LANDING.brand.name}
        </span>
        <span
          style={{
            fontSize: fontSize * 0.5,
            fontWeight: 400,
            marginLeft: fontSize * 0.05,
            position: "relative",
            top: fontSize * 0.15,
          }}
        >
          {LANDING.brand.suffix}
        </span>
      </div>
    </div>,
    {
      width: sizePx,
      height: sizePx,
      fonts: [
        { name: "Geist", data: semibold, weight: 600, style: "normal" },
        { name: "Geist", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
