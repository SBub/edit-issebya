import { renderBrandIcon } from "@/components/BrandIcon";

// The favicon: the header's wordmark (src/components/BrandIcon.tsx).
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return renderBrandIcon(size.width);
}
