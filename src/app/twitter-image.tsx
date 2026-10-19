import { OG_IMAGE_ALT, OG_IMAGE_SIZE, renderOgImage } from "@/components/OgImage";

// The link preview for WhatsApp, iMessage, LinkedIn and the like
// (src/components/OgImage.tsx). Literal config exports: Next reads them from
// this file.
export const alt = OG_IMAGE_ALT;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage();
}
