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
    id: "poster-reel-03",
    title: "Poster",
    caption: "Bold red type and product cut-ins. The same take, made loud.",
    label: "Visual identity 1",
    duration: "0:11",
    videoSrc: "/reels/poster-reel-03.mp4",
    poster: "/reels/poster-reel-03.jpg",
  },
  {
    id: "statement-reel-01",
    title: "Statement",
    caption: "One colour, light type, nothing else. The words carry it.",
    label: "Visual identity 2",
    duration: "0:11",
    videoSrc: "/reels/statement-reel-01.mp4",
    poster: "/reels/statement-reel-01.jpg",
  },
  {
    id: "editorial-reel-02",
    title: "Editorial",
    caption: "Typewriter captions on a quiet label. The same take, made calm.",
    label: "Visual identity 3",
    duration: "0:11",
    videoSrc: "/reels/editorial-reel-02.mp4",
    poster: "/reels/editorial-reel-02.jpg",
  },
];
