import { renderBrandIcon } from "@/components/BrandIcon";

// The Apple touch icon: the header's wordmark (src/components/BrandIcon.tsx).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return renderBrandIcon(size.width);
}
