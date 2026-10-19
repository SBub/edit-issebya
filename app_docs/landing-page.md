# Landing page

**Specifications:**

- specs/issue-1-adw-d5416729-sdlc_planner-one-page-landing-checkout.md

The whole site is one page at `/`: the brand, a description, how it works, what you get, the price,
a slider of edited reels and one call to action that opens the discovery-call form (see
`app_docs/checkout.md`). On wide screens and tablets in landscape it is one screen that never
scrolls; on phones and tablets in portrait it stacks and scrolls vertically, never sideways.
Nothing is clipped and nothing is hidden.

## Layout

- `src/app/page.tsx` renders one `<main class="landing grid">` with four grid areas:
  - `title`: a `header` across the top with the brand as the `h1` ("edit" with "issebya" set small
    and low on its right, a `sub`, like a chemical index; its accessible name is "edit issebya").
  - `text`: `LANDING.description` (paragraphs of sentences, each sentence on its own line and with
    no full stop), the offer line ("8 reels, each under 1 min*"), the price from
    `formatOfferPrice()` under it, and `LANDING.offerNote` (the offer is valid for 30 days from
    purchase).
  - `slider`: `ReelSlider` (`src/components/ReelSlider.tsx`).
  - `cta`: a bordered `section` named "Offer" (`rounded-lg border-neutral-200`, the ADW
    dashboard's card style): the price, `CallRequest` (`src/components/CallRequest.tsx`, the "Start
    your 30 days" button in the dashboard's Work with me style: fuchsia 700, `rounded-md`), what
    happens after payment (`LANDING.afterPurchase`) and a "Questions first? Message me here" mail
    link (`LANDING.questions`).
- All copy lives in `src/content/landing.ts` (`LANDING`), read by the page and the specs alike.
- `src/app/globals.css` defines the `.landing` grid. The title row spans the full width. Below it,
  on narrow screens, one column (slider, text, CTA). At `@media (min-width: 64rem), (min-width:
48rem) and (orientation: landscape)` two columns: the slider on the left, text and CTA on the
  right.
- On one-screen viewports the main is `100dvh` and every row is sized from it; the slider media is
  the only part that flexes. On stacked viewports the main is at least `100dvh`, grows with its
  content, and the slider area (`.reel-area`) is `min(75svh, 40rem)` tall so the reels stay a
  usable size.
- The page is white in every colour scheme: `:root` sets `color-scheme: light` and there is no
  dark override. `html` and `body` both carry the background.
- `html` has `scrollbar-gutter: stable`, so the layout does not shift if a page starts to scroll.

## No-scroll rule and its specs

At the eleven viewports in `e2e/viewport.ts` (320x568 up to 1920x1080), with no dialog, with the
form dialog open and with the thank-you dialog open:

- one-screen viewports (`oneScreen()`, mirroring the two-column breakpoint):
  `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth` on `document.documentElement`;
- stacked viewports: `scrollWidth <= clientWidth` (vertical scroll is expected);
- `html` and `body` overflow is neither `hidden` nor `clip`;
- every required element is visible and inside the root box once scrolled to.

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
- Card slots follow the slider's own width through a container query: one per view on phones (85%
  of the width, so the next card peeks in and the swipe is discoverable), two, three, then up to
  four on wide screens.
- There are no previous/next buttons. The track moves by swiping or scrolling, and ArrowLeft and
  ArrowRight move it when focus is inside it. Smooth scrolling is off under
  `prefers-reduced-motion: reduce`.
- Under the "Edited reels" heading, above the track, `LANDING.variations` says the reels are variations and the buyer's will match
  their project's ICP and UVP.
- No autoplay. `ReelCard` videos are `playsInline`, `loop` and paused until clicked, and play with
  sound. Starting one pauses any other (a `reel-play` document event), so only one is heard at a
  time. A reel without `videoSrc` renders "Reel coming soon".
- Specs: `e2e/reel_slider.spec.ts`.

## How to add a reel

1. Put `<id>.mp4` and `<id>.jpg` in `public/reels/`.
2. Add an entry to `REELS` in `src/content/reels.ts` with `id`, `title` (names the card for screen
   readers), `label` (shown under the video), `videoSrc: "/reels/<id>.mp4"` and
   `poster: "/reels/<id>.jpg"`.
3. The slider and its specs pick it up. Run `yarn test:e2e` to confirm nothing scrolls.

The `id` is the `reel_id` sent with `reel_played` (see `app_docs/analytics.md`), so an existing id
never changes.

## Card styling sources

`ReelCard` takes its label, never its code, from the issebya.homes website's
`apps/website/src/app/(main)/shop/ui/ProductCard.tsx`: the small, spaced, uppercase line under the
media. There is no visible title, duration or caption, and no card colour or padding: the video
and its label sit on the page's white. The title is an `sr-only` `h3` that names the card.

Type follows the ADW dashboard (build.issebya.com): Tailwind's default sans stack, no web font.

Deliberate differences from the shop card:

- the media is 9:16: the card is a size container and the 9:16 box takes the largest size that
  fits it above the fixed-height label row (`--reel-label`).

## Rules

- Never let the page scroll on one-screen viewports, with or without a dialog open, and never let
  it scroll sideways anywhere.
- Never set `overflow: hidden` or `overflow: clip` on `html` or `body`.
- Never hide or cut off a required element below a breakpoint to make it fit.
- Never use a non-white page background, in any colour scheme.
- Never autoplay a reel or play sound unasked.
- Never measure from `window.innerWidth` or `window.innerHeight` in specs; measure from the root
  box.
- Do not change the `id` of an existing reel.
