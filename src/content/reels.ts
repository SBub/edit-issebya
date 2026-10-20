// The reels in the slider, in order. To add a real one, put `<id>.mp4` and
// `<id>.jpg` in public/reels/ and set videoSrc and poster to `/reels/<id>.mp4`
// and `/reels/<id>.jpg`; the title names the card for screen readers
// (see app_docs/landing-page.md). A null videoSrc renders "Reel coming soon".

export interface Reel {
  id: string;
  title: string;
  label: string;
  videoSrc: string | null;
  poster: string | null;
}

export const REELS: readonly Reel[] = [
  {
    id: "poster-reel-04",
    title: "Poster",
    label: "Visual identity 1",
    videoSrc: "/reels/poster-reel-04.mp4",
    poster: "/reels/poster-reel-04.jpg",
  },
  {
    id: "statement-reel-01",
    title: "Statement",
    label: "Visual identity 2",
    videoSrc: "/reels/statement-reel-01.mp4",
    poster: "/reels/statement-reel-01.jpg",
  },
  {
    id: "editorial-reel-02",
    title: "Editorial",
    label: "Visual identity 3",
    videoSrc: "/reels/editorial-reel-02.mp4",
    poster: "/reels/editorial-reel-02.jpg",
  },
];

/** The reel's 1-based position in REELS (the `variant` property), or null. */
export function reelVariant(id: string): number | null {
  const index = REELS.findIndex((reel) => reel.id === id);
  return index === -1 ? null : index + 1;
}
