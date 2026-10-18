# Landing page

**Specifications:**

- specs/issue-1-adw-d5416729-sdlc_planner-one-page-landing-checkout.md

The whole site is one screen at `/`: a heading, the process, the offer and its price, a slider of
edited reels and one call to action that opens the discovery-call form (see
`app_docs/checkout.md`). At every supported viewport the page never scrolls, nothing is clipped and
nothing is hidden.

## Layout

- `src/app/page.tsx` renders one `<main class="landing grid h-dvh">` with three grid areas:
  - `text`: the `h1`, the sub-line, the for-whom text, an `<ol aria-label="Process">` of the four
    `LANDING.steps`, the offer line and the price from `formatOfferPrice()`.
  - `slider`: `ReelSlider` (`src/components/ReelSlider.tsx`).
  - `cta`: `CallRequest` (`src/components/CallRequest.tsx`).
- All copy lives in `src/content/landing.ts` (`LANDING`), read by the page and the specs alike.
- `src/app/globals.css` defines the `.landing` grid. On narrow screens it is one column (slider,
  text, CTA). At `@media (min-width: 64rem), (min-width: 48rem) and (orientation: landscape)` it
  becomes two columns: the slider on the left, text and CTA on the right.
- Every row is sized from the main's `h-dvh`. The slider media is the only part that flexes.
- The page is white in every colour scheme: `:root` sets `color-scheme: light` and there is no
  dark override. `html` and `body` both carry the background.
- `html` has `scrollbar-gutter: stable`, so the layout does not shift if a page starts to scroll.

## No-scroll rule and its specs

At the eleven viewports in `e2e/viewport.ts` (320x568 up to 1920x1080), with no dialog, with the
form dialog open and with the thank-you dialog open:

- `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth` on `document.documentElement`;
- `html` and `body` overflow is neither `hidden` nor `clip`;
- every required element is visible and inside the root box.

`e2e/no_scroll.spec.ts` and `e2e/landing_content.spec.ts` check this, with the helpers in
`e2e/viewport.ts` (`rootBox`, `expectInsideRoot`). The helpers measure from
`document.documentElement`, never from `window.innerWidth`. At 320x568 the dialogs scroll inside
themselves (the form body is `overflow-y-auto`, the dialog is capped at `100dvh - 2rem`), never the
page.

## Height variants

Width alone cannot tell 320x568 from 390x844 (the case the comment in `globals.css` calls out), so
two custom variants step down with the viewport height:

- `@custom-variant short (@media (max-height: 700px))`
- `@custom-variant tiny (@media (max-height: 600px))`

`short:`, `tiny:` and `lg:short:` reduce text size, gaps and padding in `page.tsx`, in `ReelCard`,
in `ReelSlider` and in `CallRequest`.

## Reel slider

- `ReelSlider` is a scroll-snap track (`snap-x snap-mandatory`) that scrolls inside the slider box,
  never the page. Moving uses `scrollBy` on the track, never `scrollIntoView`.
- Card slots follow the slider's own width through a container query: one per view on phones, two,
  three, then up to four on wide screens.
- Previous and next buttons have the accessible names "Previous reel" and "Next reel" and are
  disabled at the ends. The end states are kept in step with a scroll listener and a
  `ResizeObserver`.
- ArrowLeft and ArrowRight move the slider when focus is inside it. Smooth scrolling is off under
  `prefers-reduced-motion: reduce`.
- No autoplay. `ReelCard` videos are `muted`, `playsInline`, `loop`, paused until clicked, with no
  unmute control. A reel without `videoSrc` renders "Reel coming soon".
- Specs: `e2e/reel_slider.spec.ts`.

## How to add a reel

1. Put `<id>.mp4` and `<id>.jpg` in `public/reels/`.
2. Add an entry to `REELS` in `src/content/reels.ts` with `id`, `title` (short), `caption` (fits two
   lines), `label`, `duration`, `videoSrc: "/reels/<id>.mp4"` and `poster: "/reels/<id>.jpg"`.
3. The slider and its specs pick it up. Run `yarn test:e2e` to confirm nothing scrolls.

The `id` is the `reel_id` sent with `reel_played` (see `app_docs/analytics.md`), so an existing id
never changes.

## Card styling sources

`ReelCard` takes its text block, never its code, from the issebya.homes website's
`apps/website/src/app/(main)/shop/ui/ProductCard.tsx`: the label, title-and-duration and caption
under the media. The card has no colour or padding of its own: it sits on the page's white.

Type follows the ADW dashboard (build.issebya.com): Tailwind's default sans stack, no web font.

Deliberate differences from the shop card:

- the media is 9:16: the media area is a size container and the 9:16 box takes the largest size
  that fits it;
- the title is underlined at rest;
- the caption is clamped to two lines (`line-clamp-2`).

## Rules

- Never let the page scroll at the listed viewports, with or without a dialog open.
- Never set `overflow: hidden` or `overflow: clip` on `html` or `body`.
- Never hide or cut off a required element below a breakpoint to make it fit.
- Never use a non-white page background, in any colour scheme.
- Never autoplay a reel or play sound unasked.
- Never measure from `window.innerWidth` or `window.innerHeight` in specs; measure from the root
  box.
- Do not change the `id` of an existing reel.
