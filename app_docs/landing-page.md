# Landing page

**Specifications:**

- specs/issue-1-adw-d5416729-sdlc_planner-one-page-landing-checkout.md

The whole site is one page at `/`: the brand, a description, how it works, what you get, the price,
a slider of edited reels, one call to action that opens the checkout form, and a footer with the
terms and privacy links (see
`app_docs/checkout.md`). On wide screens and tablets in landscape it is one screen that never
scrolls; on phones and tablets in portrait it stacks and scrolls vertically, never sideways.
Nothing is clipped and nothing is hidden.

## Layout

- `src/app/page.tsx` renders one `<main class="landing grid">` with four grid areas:
  - `title`: a `header` across the top with the brand as the `h1` ("edit" with "issebya" set small
    and low on its right, a `sub`, like a chemical index; its accessible name is "edit issebya").
  - `text`: the quote (`LANDING.quote`, "Your ideas deserve reels that look like your brand. And
    you deserve your evenings back") first and highlighted: in curly quotes, italic, `font-semibold`,
    two steps above the body text (`text-lg`, `lg:text-xl`) and stepped down by `short:`,
    `tiny:`, `lg:mid:` and `lg:short:`. No trailing full stop inside the quote. It is a `p`, not a
    `blockquote`: the owner's own tagline, not a quotation from elsewhere. Then the introduction
    (`LANDING.intro`, "I'm a reel editor for founders and experts...") as body text, then "How we
    work together", "What you get" and the closing line.
  - `slider`: `ReelSlider` (`src/components/ReelSlider.tsx`).
  - `cta`: a bordered `section` named "Offer" (`rounded-lg border-neutral-200`, the ADW
    dashboard's card style): the price (while early-bird spots remain, "590 EUR" with the
    full price struck through and "First 4 clients only, N of 4 spots left"; always the grey line "VAT exempt under art. 53
    CIVA" (`LANDING.vatExempt`) under the price, with no "+ VAT" anywhere; see
    `app_docs/checkout.md`, "Early-bird price"), `CallRequest` (`src/components/CallRequest.tsx`, the "Start
    your 30 days" button in the dashboard's Work with me style: fuchsia 700, `rounded-md`), what
    happens after payment (`LANDING.afterPurchase`) and "Questions first? Message me here", a link
    that opens a WhatsApp chat in a new tab (`src/components/QuestionsLink.tsx`; the number and
    the prefilled text are defined once in `LANDING.questions`, the `href` is built by
    `whatsAppUrl` in `src/lib/whatsapp.ts`). The same link is used on `/`, `/terms` and `/privacy`.
- All copy lives in `src/content/landing.ts` (`LANDING`), read by the page and the specs alike.
- `footer`: a `nav` named "Legal" with links to `/terms`, `/privacy` and the "Complaints book"
  (`LANDING.complaintsBook`, https://www.livroreclamacoes.pt, new tab), wrapping on narrow
  phones. The legal pages and their content are described in `app_docs/legal-pages.md`.
  `LegalPage` shares the landing page's padding (`PAGE_PADDING`) and brand placement and
  typography (`BRAND_CLASS`, `BrandName`), all from `src/components/Brand.tsx`, left aligned, so
  the brand sits at the same spot on all three pages. Specs: `e2e/legal_pages.spec.ts`.
- The "8 reels, each under 1 min" item's note ("longer ones: terms of service apply") links to
  `/terms#reel-length`.
- `src/app/globals.css` defines the `.landing` grid. Narrow screens: one column (title, the
  quote and the introduction, the reels, then "How we work together", "What you get" and the closing
  line, CTA, footer): `.landing-text` is `display: contents` there, so `.landing-intro` and
  `.landing-details` are placed around the slider. At `@media (min-width: 64rem), (min-width: 48rem) and (orientation:
landscape)` two columns: brand, slider and footer on the left; the text, then the offer
  section, in one flex column on the right (grid areas `"title text" "slider text" "footer
text"`).
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

Three custom variants step text, gaps and padding down with the viewport height, in the
one-screen layout only: `mid` (`max-height: 820px`), `short` (700px) and `tiny` (600px), each
combined with the two-column breakpoint (`(min-width: 64rem)`, or `(min-width: 48rem)` in
landscape) as block-form `@custom-variant`s with `@slot` in `globals.css` (the shorthand form
cannot take a comma media list). The stacked layout scrolls, so height never tightens it: a phone
in portrait never matches any of them, at any height. The `.reel-track` label height step uses
the same condition.

`short:`, `tiny:`, `mid:` and `lg:short:` reduce text size, gaps and padding in `page.tsx`,
`Brand.tsx` (`PAGE_PADDING`, `BRAND_CLASS`), `ReelCard`, `ReelSlider` and `CallRequest`.

Lists ("How we work together", "What you get") use hanging indents (`list-outside pl-5`, so
wrapped lines align with the text), `space-y-1` between items and `mb-2` under the heading;
`mid:` drops both so the one-screen column still fits.

### Equal gaps

Every gap between consecutive blocks is the same, on every viewport.

- Stacked: one value, `--landing-gap` on `.landing` (3rem, at every phone height), is the grid's
  `row-gap` and the `gap` of `.landing-intro` and
  `.landing-details`. So title, quote, introduction, reels, "How we work together", "What you
  get", closing line, offer box and footer are all that far apart.
- Two columns: the offer box sits inside `.landing-text` (on phones `.landing-text` is
  `display: contents`, so `[grid-area:cta]` still places it), and `.landing-intro` and
  `.landing-details` are `display: contents`, so quote, introduction, the two sections, closing
  line and offer box are flex items of one column. A `Spacer` (`.landing-spacer`) sits between
  every pair; all are identical (`flex: 1 1 0`, `min-height` 1rem, 0.5rem at
  `max-height: 820px`, `max-height` 6rem), so they grow equally into the free height and the
  column can never overflow. The left column's rows (title, slider, footer) keep `row-gap` 1rem
  (0.625rem at `max-height: 700px`).
- Spec: `e2e/equal_gaps.spec.ts` measures the gaps at 1440x900 and 1280x800 (equal within 1px)
  and on phones at 390x844, 375x667 and 320x568 (all 48px within 1px, reels and footer
  included), checks the section text keeps its size on a short phone, and checks the hanging
  indents and item spacing.

## Reel slider

- `ReelSlider` is a scroll-snap track (`snap-x snap-mandatory`) that scrolls inside the slider box,
  never the page. Moving uses `scrollBy` on the track, never `scrollIntoView`.
- Card slots follow the slider's own width through a container query: one per view on phones,
  centred (`snap-center`, with 7.5% padding either side so the neighbours peek in and the swipe is
  discoverable), two, three, then up to four on wide screens.
- When the track overflows (phones, tablets in portrait), dots under it show which reel is in
  view (`aria-current`) and jump to one when tapped; wide screens, where every reel fits, show
  none.
- On phones each reel has a "Full screen" button (top right of the video) that plays it full
  screen with sound: `requestFullscreen` on the video, or `webkitEnterFullscreen` on iOS Safari.
  Wide screens hide it (`.reel-fullscreen` in globals.css).
- The stacked layout's height uses `svh`, never `dvh`: the phone address bar showing and hiding
  while scrolling changes `dvh`, which re-measured every reel on each scroll step.
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

## Link previews

- `src/app/layout.tsx` sets `openGraph` (`type` website, `siteName` and `title` "edit issebya",
  `description` `LANDING.quote`, `locale` en) and `twitter` (`card`
  `summary_large_image`). `metadataBase` makes every image URL absolute.
- `src/app/opengraph-image.tsx` and `src/app/twitter-image.tsx` are Next's file conventions and
  both render `renderOgImage()` (`src/components/OgImage.tsx`, `ImageResponse` from `next/og`):
  1200x630, white, the "edit" wordmark with "issebya" set small and low, a short fuchsia-700 rule,
  the first sentence of `LANDING.quote`, and the first three `REELS` posters as rounded 9:16
  thumbnails, read from `public/` with `fs/promises` and inlined as data URLs. The config exports
  (`alt`, `size`, `contentType` `image/jpeg`) stay literal in each route file.
- Format and size: the preview is a JPEG, about 60 KB. `ImageResponse` only renders PNG, and that
  PNG is about 490 KB, so `renderOgImage` re-encodes it with `sharp` (quality 85, mozjpeg; the same
  `sharp` Next uses for images, listed in `dependencies`) and returns a plain `Response` with
  `Content-Type: image/jpeg` and the `ImageResponse`'s `Cache-Control`. WhatsApp desktop and
  WhatsApp Web show an empty grey preview for images over about 300 KB (WhatsApp mobile still
  shows them). Both routes are prerendered at build time, so a changed reel poster or quote shows
  up on the next deploy with no file to regenerate; the `?<hash>` Next appends to the image URL
  changes with it.
- `src/app/icon.tsx` (32x32 favicon) and `src/app/apple-icon.tsx` (180x180 Apple touch icon)
  both render `renderBrandIcon` (`src/components/BrandIcon.tsx`): the header's wordmark ("edit"
  in semibold with "issebya" small and low on its right), black on white, centred, about 90% of
  the width. Fonts: Geist SemiBold and Regular in `assets/fonts` (SIL Open Font License,
  `Geist-OFL.txt`), because the image renderer only ships a regular weight. At 32px "issebya" is
  too small to read; it shows as a fine grey line.
- Spec: `e2e/link_preview.spec.ts` (the `og:` and `twitter:` tags with `image/jpeg` type, size and
  alt, absolute image URLs; both preview images answer 200 `image/jpeg`, 1200x630, under 300,000
  bytes; the icon and the Apple touch icon answer 200 `image/png`).

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
- Never give two consecutive blocks of the text column (or of the stacked page) different gaps:
  one `--landing-gap` when stacked, identical `.landing-spacer`s in two columns.
- Never let a height-based variant or media query tighten the stacked layout: height steps are
  for the one-screen layout only.
- Never autoplay a reel or play sound unasked.
- Never measure from `window.innerWidth` or `window.innerHeight` in specs; measure from the root
  box.
- Do not change the `id` of an existing reel.
- Never ship a link preview image over 300 KB or as PNG: WhatsApp desktop and WhatsApp Web drop
  the preview above about 300 KB.
- Never give the terms and privacy pages a different container, padding or brand position from
  `/`.
