import { ImageResponse } from "next/og";

// The favicon: the wordmark's "e" in neutral-900 on white.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
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
        fontSize: 30,
        fontWeight: 600,
        lineHeight: 1,
        paddingBottom: 4,
      }}
    >
      e
    </div>,
    { ...size },
  );
}
