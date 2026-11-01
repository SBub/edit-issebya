// The part of `navigator` the check reads. Client hints are Chromium-only.
export interface NavigatorLike {
  userAgent: string;
  userAgentData?: { brands?: readonly { brand: string }[] };
}

// The preview is built for Chrome (and other Chromium browsers); elsewhere the
// page shows a note, never a block.
export function isChromium(nav: NavigatorLike): boolean {
  const brands = nav.userAgentData?.brands;
  if (brands) return brands.some(({ brand }) => brand === "Chromium");
  const ua = nav.userAgent;
  return (ua.includes("Chrome/") || ua.includes("Edg/")) && !ua.includes("Firefox/");
}
