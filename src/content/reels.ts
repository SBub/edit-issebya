// The reels in the slider, in order. To add a real one, put `<id>.mp4` and
// `<id>.jpg` in public/reels/ and set videoSrc and poster to `/reels/<id>.mp4`
// and `/reels/<id>.jpg`; keep the title short and the caption to two lines
// (see app_docs/landing-page.md). A null videoSrc renders "Reel coming soon".

export interface Reel {
  id: string;
  title: string;
  caption: string;
  label: string;
  duration: string;
  videoSrc: string | null;
  poster: string | null;
}

export const REELS: readonly Reel[] = [
  {
    id: "founder-story",
    title: "Founder story",
    caption: "Why the company exists, told in one take and cut to the beat.",
    label: "Founder",
    duration: "0:28",
    videoSrc: null,
    poster: null,
  },
  {
    id: "expert-tip",
    title: "Expert tip",
    caption: "One idea, one minute of footage, twenty-five seconds on screen.",
    label: "Expert",
    duration: "0:25",
    videoSrc: null,
    poster: null,
  },
  {
    id: "product-demo",
    title: "Product demo",
    caption: "Talking head and screen, captioned so it works without sound.",
    label: "Product",
    duration: "0:22",
    videoSrc: null,
    poster: null,
  },
  {
    id: "behind-the-scenes",
    title: "Behind the scenes",
    caption: "A day at work, trimmed to the moments that carry the story.",
    label: "Studio",
    duration: "0:29",
    videoSrc: null,
    poster: null,
  },
];
