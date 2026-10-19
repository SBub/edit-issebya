# Feature: "Message me here" opens WhatsApp, and the legal pages share the landing container

## Metadata

issue_number: `7`
adw_id: `10a9117d`
issue_json: `{"number":7,"title":"feat: Message me here opens WhatsApp, and the legal pages share the landing container"}`

## Feature Description

Two small changes to rendered pages:

1. The "Message me here" link (landing offer section, `/terms`, `/privacy`) opens a WhatsApp chat
   with the owner (`+351 920 742 845`) in a new tab, with the prefilled message
   `Hi, I saw your reel editing offer and have a few questions before I start`, instead of a
   `mailto:` link. The number and text live once in `LANDING.questions`; the `href` is built by a
   small pure helper with `encodeURIComponent`.
2. The terms and privacy pages use the landing page's padding (every height and breakpoint step)
   and brand placement and typography, taken from one shared place, so the brand sits at exactly the
   same spot when moving between `/`, `/terms` and `/privacy`.

## User Story

As a founder considering the offer
I want "Message me here" to open a WhatsApp chat with a ready message, and the brand to stay put
when I open the terms or privacy page
So that asking a question takes one tap and the site feels like one coherent place

## Problem Statement

- `LANDING.questions.href` is `mailto:sveta@issebya.com`; the owner wants questions on WhatsApp.
  The link is duplicated in three places with no `target`/`rel`, so the sites can drift.
- `LegalPage` renders `mx-auto max-w-2xl p-6 lg:p-10`: a centred 42rem column. At 1440x900 the
  landing brand starts at x = 40 and the legal brand at about x = 424, so it jumps sideways on
  navigation. Its padding also lacks the `short`/`tiny`/`lg:short` steps, and the brand lacks
  `short:text-lg`, so it also shifts on short viewports.

## Solution Statement

- Add `src/lib/whatsapp.ts` with `whatsAppUrl(number, text)` returning
  `` `https://wa.me/${number}?text=${encodeURIComponent(text)}` ``, unit tested.
- In `src/content/landing.ts`, keep the number (`"351920742845"`, digits only) and the text in
  `questions` and build `questions.href` with `whatsAppUrl` (relative import
  `../lib/whatsapp`, because the e2e specs import `../src/content/landing` by relative path and
  Playwright does not resolve the `@/` alias).
- Add `src/components/QuestionsLink.tsx`: one `<a>` with `href={LANDING.questions.href}`,
  `target="_blank"`, `rel="noopener noreferrer"`, visible text `LANDING.questions.link`, and an
  optional `className` for each site's existing colours. All three render sites use it.
- Add `src/components/Brand.tsx` exporting the shared layout pieces: `PAGE_PADDING`
  (`"p-6 short:p-4 tiny:p-3 lg:p-10 lg:short:p-6"`), `BRAND_CLASS`
  (`"text-xl font-semibold tracking-tight short:text-lg"`) and `BrandName` (the "edit" text plus
  the `sub` "issebya"). `page.tsx` and `LegalPage.tsx` both use them, so they cannot drift.
- `LegalPage`: drop `mx-auto` and the outer `max-w-2xl`; the `main` becomes
  `flex min-h-dvh flex-col gap-6` plus `PAGE_PADDING`. The brand `Link` stays a direct flex child
  (so it is blockified and its top equals the padding edge exactly like the landing `h1`, which
  an inline link inside a wrapper would not), with `BRAND_CLASS` and `<BrandName />`, still named
  "edit issebya, home" and not a heading. The `h1` and body keep `max-w-2xl` on themselves, left
  aligned at the brand's left edge.

## Relevant Files

Use these files to implement the feature:

- `AGENTS.md`: rules (Yarn only, no em-dashes, measure from the root box, docs in the same change).
- `docs/conditional-docs.md`: index; the landing-page line matches (page layout, copy). Unchanged.
- `app_docs/landing-page.md`: feature doc for the layout and copy; Layout and footer bullets and
  Rules updated in this change.
- `.adw/project.md`: profile (commands, ports, review captures). No change needed: no script, port,
  env file or docs location moves.
- `src/content/landing.ts`: `LANDING.questions` (only that key changes).
- `src/app/page.tsx`: the landing `main` (padding classes via `PAGE_PADDING`), the brand `h1`
  (via `BRAND_CLASS` and `BrandName`) and the questions link in the "Offer" section.
- `src/components/LegalPage.tsx`: the legal shell whose container and brand change.
- `src/app/terms/page.tsx`, `src/app/privacy/page.tsx`: the "Questions?" link.
- `src/app/globals.css`: read only; defines `.landing` grid and the `short`, `tiny`, `mid` variants.
  Must not change.
- `e2e/landing_content.spec.ts`: existing `href` assertion and "has its own page with a way home"
  test; must stay green.
- `e2e/viewport.ts`: `VIEWPORTS`, `waitForPageReady`, `rootBox` helpers to reuse.
- `src/lib/site-url.test.ts`: model for the unit test style.
- `knip.json`: every new export must be used (the constants and components are imported by both
  pages; the helper by `landing.ts` and its test).

### New Files

- `src/lib/whatsapp.ts`: `whatsAppUrl(number, text)`.
- `src/lib/whatsapp.test.ts`: unit test for the helper.
- `src/components/QuestionsLink.tsx`: the shared WhatsApp link.
- `src/components/Brand.tsx`: `PAGE_PADDING`, `BRAND_CLASS`, `BrandName`.
- `e2e/legal_pages.spec.ts`: WhatsApp link, brand position and left edge specs.

## Implementation Plan

### Phase 1: Foundation

Pure helper and its unit test, then the content change in `LANDING.questions`.

### Phase 2: Core Implementation

The two shared components (`QuestionsLink`, `Brand`), then `LegalPage` rebuilt on the shared
padding and brand.

### Phase 3: Integration

Swap the three render sites to `QuestionsLink`, move the landing page's padding and brand classes
to the shared constants without changing the resulting class set, add the e2e spec, update
`app_docs/landing-page.md`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Add the WhatsApp helper and its unit test

- Create `src/lib/whatsapp.ts`:
  ```ts
  // A WhatsApp click-to-chat link: the number in international form, digits
  // only, and the message the chat opens with.
  export function whatsAppUrl(number: string, text: string): string {
    return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  }
  ```
- Create `src/lib/whatsapp.test.ts` (Vitest, style of `site-url.test.ts`):
  - with `number = "351920742845"` and the literal text, the result equals
    `"https://wa.me/351920742845?text=" + encodeURIComponent(text)` and starts with
    `https://wa.me/351920742845?text=`;
  - `new URL(result).searchParams.get("text")` equals the input text exactly (including the comma);
  - a text with `&`, `?`, `#` and spaces round-trips exactly (no hand encoding leaks through).

### 2. Point `LANDING.questions` at WhatsApp

- In `src/content/landing.ts` add `import { whatsAppUrl } from "../lib/whatsapp";` (relative, with
  a short comment that the e2e specs import this file by relative path).
- Define the questions content once, above `LANDING`:
  ```ts
  const questions = {
    lead: "Questions first?",
    link: "Message me here",
    // WhatsApp: the number digits only, and the message the chat opens with.
    number: "351920742845",
    text: "Hi, I saw your reel editing offer and have a few questions before I start",
  } as const;
  ```
  and in `LANDING`: `questions: { ...questions, href: whatsAppUrl(questions.number, questions.text) },`.
  `LANDING.questions.href` stays the field every render site and spec reads. Touch no other key
  (issue #6 edits `afterPurchase` and `thankYou` next).

### 3. Add the shared `QuestionsLink`

- Create `src/components/QuestionsLink.tsx`, a server component:
  ```tsx
  /** "Message me here": opens the WhatsApp chat in a new tab, on every page that offers it. */
  export function QuestionsLink({ className }: { className?: string }) {
    return (
      <a
        href={LANDING.questions.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {LANDING.questions.link}
      </a>
    );
  }
  ```
  (import `LANDING` from `@/content/landing`).

### 4. Add the shared brand and padding

- Create `src/components/Brand.tsx` exporting:
  - `PAGE_PADDING = "p-6 short:p-4 tiny:p-3 lg:p-10 lg:short:p-6"` with a comment that `/`,
    `/terms` and `/privacy` share it so the brand never moves between them;
  - `BRAND_CLASS = "text-xl font-semibold tracking-tight short:text-lg"`;
  - `BrandName()` returning `<>{LANDING.brand.name}<sub className="ml-0.5 align-sub text-[0.5em] font-normal tracking-normal">{LANDING.brand.suffix}</sub></>`.
    Full literal class strings only (Tailwind scans them from source).

### 5. Use them on the landing page, without changing its classes

- In `src/app/page.tsx`:
  - `main`: ``className={`landing grid gap-x-10 gap-y-4 short:gap-y-2.5 tiny:gap-y-2 ${PAGE_PADDING}`}``.
    The resulting class set is identical to today's; the grid, gaps and `globals.css` are untouched.
  - `h1`: keep `aria-label`, `className={BRAND_CLASS}`, children `<BrandName />`.
  - Offer section: replace the `<a ...>` with
    `<QuestionsLink className="text-neutral-900 underline underline-offset-2 hover:text-fuchsia-700" />`;
    `lead`, the space and the trailing `.` stay.

### 6. Rebuild `LegalPage` on the landing container

- `src/components/LegalPage.tsx`:
  - `main`: ``className={`flex min-h-dvh flex-col gap-6 ${PAGE_PADDING}`}``. No `mx-auto`, no
    `max-w-2xl` on the `main`.
  - The brand `Link` stays the first direct child of `main` (blockified flex item, so its top is
    the padding edge like the landing `h1`), `href="/"`, `aria-label` "edit issebya, home",
    `className={BRAND_CLASS}`, children `<BrandName />`. It is not a heading.
  - `h1`: `className="max-w-2xl text-2xl font-medium tracking-tight"`, unchanged otherwise.
  - Body `div`: add `max-w-2xl` to its existing classes.
  - Update the doc comment: it shares the landing page's padding and brand placement.

### 7. Swap the legal pages' links

- `src/app/terms/page.tsx` and `src/app/privacy/page.tsx`: replace the `<a ...>` with
  `<QuestionsLink className="underline underline-offset-2" />`; drop the now unused `LANDING`
  import. Titles, stub texts and `metadata` unchanged.
- Confirm `grep -rn "mailto:" src/` returns nothing.

### 8. Add `e2e/legal_pages.spec.ts`

- Imports: `expect`, `test`, `type Page` from `@playwright/test`; `LANDING` from
  `../src/content/landing`; `waitForPageReady` from `./viewport`.
- Constants written out in the spec: `const WHATSAPP_TEXT = "Hi, I saw your reel editing offer and have a few questions before I start";`,
  `const LEGAL = [{ path: "/terms", title: "Terms and conditions" }, { path: "/privacy", title: "Privacy policy" }];`,
  `const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }];`.
- **WhatsApp link**, one test per path in `["/", "/terms", "/privacy"]`: `goto(path)`;
  `link = page.getByRole("link", { name: LANDING.questions.link })`; read `href`;
  `const url = new URL(href!)`; expect `url.origin` `"https://wa.me"`, `url.pathname`
  `"/351920742845"`, `url.searchParams.get("text")` `WHATSAPP_TEXT`; `toHaveAttribute("target", "_blank")`;
  `toHaveAttribute("rel", /noopener/)`.
- **Brand position and left edge**, for each size and each legal page:
  - `setViewportSize(size)`; `goto("/")`; `waitForPageReady(page)`; box of
    `getByRole("heading", { level: 1, name: "edit issebya" })`.
  - `goto(path)`; `page.evaluate(() => document.fonts.ready.then(() => undefined))`; box of
    `getByRole("link", { name: "edit issebya, home" })` and of
    `getByRole("heading", { level: 1, name: title })`.
  - `expect(Math.abs(legal.x - landing.x)).toBeLessThanOrEqual(1)`, same for `y`;
    `expect(Math.abs(title.x - legal.x)).toBeLessThanOrEqual(1)`.
  - Positions only come from `boundingBox()` (document coordinates relative to the viewport,
    identical scroll position 0 on both pages); never `window.innerWidth`.
- Falsifiable: with `mx-auto max-w-2xl` on the `main` the 1440x900 x check fails (40 vs about
  424); with the `mailto:` href the `new URL` origin check fails.
- Leave `e2e/landing_content.spec.ts` and `e2e/no_scroll.spec.ts` untouched; the existing `href`
  equality and "way home" tests must stay green.

### 9. Update `app_docs/landing-page.md`

- Layout, `cta` bullet: replace "a 'Questions first? Message me here' mail link
  (`LANDING.questions`)" with a link that opens a WhatsApp chat in a new tab
  (`src/components/QuestionsLink.tsx`; number and prefilled text defined in `LANDING.questions`,
  the `href` built by `whatsAppUrl` in `src/lib/whatsapp.ts`), used on `/`, `/terms` and
  `/privacy`.
- Footer bullet: the stubs render through `LegalPage`, which shares the landing page's padding
  (`PAGE_PADDING`) and brand placement and typography (`BRAND_CLASS`, `BrandName`, from
  `src/components/Brand.tsx`), left aligned; specs in `e2e/legal_pages.spec.ts`.
- Rules: add "Never give the terms and privacy pages a different container, padding or brand
  position from `/`."
- No em-dashes. `docs/conditional-docs.md` and `app_docs/checkout.md` unchanged.

### 10. Run the validation commands

- Run every command in `Validation Commands` below and fix anything that fails.

## Testing Strategy

### Unit Tests

- `src/lib/whatsapp.test.ts`: exact URL shape, round-trip of the `text` parameter including the
  comma, and round-trip of reserved characters (`&`, `?`, `#`, spaces).

### Test Coverage

- Unit, `src/lib/whatsapp.test.ts`: catches a hand-encoded or wrongly encoded URL; nothing tests
  URL building today (fails without the helper: the module does not exist).
- E2E, `e2e/legal_pages.spec.ts` "WhatsApp link" on `/`, `/terms`, `/privacy`: catches a `mailto:`
  or wrong number/text (written literally, so a wrong constant fails) and a missing new tab or
  `noopener`; the current spec only compares `href` to the constant itself.
- E2E, `e2e/legal_pages.spec.ts` "brand position" at 1440x900, 390x844, 320x568: catches the
  legal brand drifting from the landing brand (centring, different padding, missing `short`/`tiny`
  step, different font size) and the title not sharing the brand's left edge; nothing measures the
  legal pages today.

### Edge Cases

- 320x568 hits `short` and `tiny` (padding `p-3`, brand `text-lg`): both pages must step together.
- 1440x900 is `lg` but not `short` (900 > 700): `p-10`; a `lg:short` viewport would be `p-6` on both.
- `scrollbar-gutter: stable` reserves the same gutter on both pages, so x stays comparable; never
  correct with `window.innerWidth`.
- The legal brand must remain a block-level box (direct flex child); wrapping it inline in a
  `header` would offset its `y` by the half-leading.
- Prefilled text contains a comma and spaces; decoding must give it back exactly.
- `/` stacks and scrolls on 390x844 and 320x568; measurements are taken right after load at scroll
  position 0, where the brand is at the top.

## Acceptance Criteria

- "Message me here" on `/`, `/terms` and `/privacy` has `href`
  `https://wa.me/351920742845?text=Hi%2C%20I%20saw%20your%20reel%20editing%20offer%20and%20have%20a%20few%20questions%20before%20I%20start`,
  `target="_blank"` and `rel="noopener noreferrer"`; visible text and surrounding copy unchanged.
- The number and text appear only in `LANDING.questions`; no `mailto:` remains in `src/`.
- All three sites render the shared `QuestionsLink`.
- `LegalPage` uses `PAGE_PADDING`, `BRAND_CLASS` and `BrandName` from `src/components/Brand.tsx`,
  which `page.tsx` also uses; no `mx-auto`.
- At 1440x900, 390x844 and 320x568 the legal brand's `x` and `y` equal the landing brand's within
  1px, and each legal title's `x` equals its brand's within 1px.
- The legal brand is a link named "edit issebya, home", the page title is the only `h1`; titles,
  stub texts and `metadata` unchanged.
- Landing grid, gaps, `globals.css` and every no-scroll spec unchanged and green.
- `app_docs/landing-page.md` updated as in step 9.
- All validation commands pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: Prettier on every file, including the new spec and components.
- `yarn lint`: ESLint over `src` and `e2e`.
- `yarn typecheck`: `next typegen` then `tsc --noEmit`; covers the `as const` spread in `LANDING`.
- `yarn knip`: no unused export from `Brand.tsx`, `QuestionsLink.tsx` or `whatsapp.ts`, no unused
  import left in the legal pages.
- `yarn test`: Vitest, including `src/lib/whatsapp.test.ts`.
- `yarn build`: `next build` with no env variables, all three pages prerender.
- `grep -rn "mailto:" src/ ; test $? -eq 1`: no mail link remains in `src/`.
- `yarn test:e2e`: run by the test phase as `PORT=<run port> yarn test:e2e` against the
  `E2E_MOCK_STRIPE=true yarn dev` server `/prepare_app` started; includes
  `e2e/legal_pages.spec.ts`, `e2e/landing_content.spec.ts` and `e2e/no_scroll.spec.ts`.

## Notes

- No new dependency.
- Review phase: besides the profile's nine captures of `/`, capture `/terms` and `/privacy` at
  1920x1080 and 375x667, and confirm the brand does not move when switching between `/` and
  `/terms` at the same viewport.
- Out of scope: legal texts, any WhatsApp icon or widget, PostHog events for the link, and the
  `/terms` and `/privacy` links in `src/components/CallForm.tsx`. Do not touch
  `LANDING.afterPurchase`, `LANDING.thankYou`, checkout files or `app_docs/checkout.md` (issue #6).
- `.adw/project.md` needs no update: no script, port, env file or docs location changes.
- Commit as `feat: ...`, no trailers (profile Documentation section).
