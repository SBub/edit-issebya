# Font pairs

A font pair is the two fonts a reel is set in. The **simple** font writes everything a viewer must read
at a glance (captions, the big word behind the speaker, the hook, questions and a list's lead-in and
numbers); the **artistic** font writes the accents only (an accent's words, a list's key phrase, the
hook's text, the accent that carries a question). Simple is always readable; artistic is the flourish.

## The six pairs

Owner-approved, all Google Fonts under the SIL Open Font License. The ids are stored in edits and
profiles, so they never change. `classic` is the default.

| id            | label       | simple (weight)              | artistic (weight)             | stands in for             |
| ------------- | ----------- | ---------------------------- | ----------------------------- | ------------------------- |
| `classic`     | Classic     | Inter Tight SemiBold (600)   | Playfair Display Italic (400) | Helvetica + PlayFair      |
| `script`      | Script      | Inter SemiBold (600)         | Pinyon Script (400)           | Inter + Bikham            |
| `signature`   | Signature   | Oswald Medium (500)          | Hurricane (400)               | Bebas Neue + Bella Script |
| `handwritten` | Handwritten | Antonio Bold (700)           | Herr Von Muellerhoff (400)    | Heading Now + Denistina   |
| `retro`       | Retro       | Unbounded (400)              | Syne SemiBold (600)           | Old Soviet + Neue Machina |
| `bold`        | Bold        | Archivo Expanded Black (900) | Oswald ExtraLight (200)       | Druk + Notepad            |

The "stands in for" names are the owner's own words for the look each pair gives, not a licence claim.

## Where it lives

- `packages/edit/src/font-pairs.ts`: `FONT_PAIRS` (id, label, `standsInFor`, `simple` and `artistic`, each
  with its CSS family, file, weight and style), the roles `FONT_ROLES`, `DEFAULT_FONT_PAIR_ID`, and the
  helpers `fontPairFiles` (a pair's files, each once) and `allFontFiles` (every file, what the studio may
  serve).
- `packages/edit/assets/fonts/`: twelve static TrueType instances (no variation table, so HarfBuzz measures
  the very file the page loads) and one `OFL-<Family>.txt` per family.
- `STYLES` (`src/variants.ts`) picks a role per text: `accent` is `artistic`; `caption` and `bigWord` are
  `simple`. A text item's `font` is a role, never a file.

## The edit and the measurer

- An edit carries `font_pair` (`src/schema.ts`), required. A version saved before font pairs has none and
  fails to parse with the reason `font_pair: a font pair is required ...`. There is no fallback to classic.
- The `Measurer` is built for one pair (`createMeasurer(hb, pair, fonts)`) and carries it as `pair`. The
  builder takes its `@font-face` rules and its font assets from `measurer.pair`, and refuses an edit whose
  `font_pair` is not that pair. So the widths the layout measured and the files the page loads are the
  same by construction.
- `editFromAnswer` and the baseline keep the pair they are given; `placeEdit` places in the measurer's pair.

## Preview, export and the studio's fonts

- The studio's preview (`ReelPreview.tsx`) parses the version first, then loads that version's pair files
  through the edit-assets route (`apps/studio/src/lib/edit-assets.ts`, which serves `allFontFiles()`) and
  builds with `createMeasurer(hb, pair, fonts)`.
- The worker's export (`render-step.ts`) measures with `editMeasurer(edit.font_pair)`. The first version,
  decide and the relayout measure with the pair they set the new version in (`apps/worker/src/edit-measurer.ts`,
  one measurer per pair per process).
  The export copies the build's font assets, which are the version's pair files.

## The profile

- `public.profiles` (migration `20261110123542_font_pair_profiles.sql`): one row per user, `font_pair` one
  of the six ids, default `classic`, `updated_at`. The user reads, inserts and changes only their own row
  and only `font_pair`; `service_role` has every privilege.
- The owner saves a pair with `public.set_font_pair(p_font_pair)` (migration
  `20261110151308_set_font_pair.sql`): a `security invoker` upsert of the caller's own row. It never names
  `user_id` (`auth.uid()` is the row), so a user who may change only `font_pair` can still save a pair. A
  plain upsert from the studio also sets `user_id` on conflict and failed with "permission denied".
  `authenticated` may execute it; `anon` and `public` may not.
- The worker reads the reel owner's pair (`apps/worker/src/font-pair-store.ts`). No row is classic.
- The decide step (`decide/run-decide.ts`) and the first version (`first-version.ts`) set the new version in
  the owner's pair, whatever pair the version they decide from is in.

## The relayout job

- `jobs.font_pair` (migration `20261110124046_relayout_jobs.sql`) and the kind `relayout`. The column is set
  for that kind only (a check), and the owner inserts the job under a policy that mirrors start over: queued,
  own reel.
- `apps/worker/src/relayout.ts` (`runRelayout`) runs in one tool step with no AI call. It parses the current
  version, reads the answer that version was decided from from its AI record (the last `decide` call that
  answered and the last `hook` call, `answerOfRecord`), places that answer with `editFromAnswer` in the job's
  pair, makes only the cut-outs the new placement needs (the cache reuses the rest), and saves a new version
  after the current one. The AI record is copied under the new version's id, so a later relayout finds the
  same answer. A version with no AI record (the first version) is placed with no answer at all.
- Going back (`restore`) copies the bytes of an old version, so it keeps the pair that version was saved in.

## The picker

- `apps/studio/src/components/FontPairPicker.tsx` is the tool panel on top of the versions column (the
  versions list is in the lower part, `LiveReel.tsx`). Each pair is a button with its label, what it stands
  in for, and a sample ("Your words" in the simple face, "with style" in the artistic one).
- The sample faces are registered with `FontFace` from the edit-assets route, once per page load
  (`apps/studio/src/lib/font-pair-faces.ts`). The picker shows the owner's profile pair as chosen.
- A pick calls `requestFontPair` (`apps/studio/src/app/change-actions.ts`): it calls `set_font_pair` for the
  profile's `font_pair`, then queues a `relayout` job for the open reel. The picker is off while the reel is blocked,
  has no version, or a job of it is live (the same rule as Start over). The new version appears in the list
  like any other.

## Rules

- Never measure a version in one pair and load or build with another: the measurer's pair is the page's,
  and `build` refuses a mismatch.
- Never read a version without `font_pair` as the classic pair. It fails to parse with the reason.
- Never rename or reuse a pair id: edits and profiles store it. A new pair is a new id.
- Never ship a variable font file. Every pair file is a static instance; `font-pairs.test.ts` checks the
  table tags of each file.
- Never ship a font file without its family's licence (`assets/fonts/OFL-*.txt`, one per family).
- Never serve a font file the pairs do not name: the edit-assets route allows exactly `allFontFiles()`.
- Never call an AI model in a relayout. It places the answer the version already holds.
- Never rewrite a stored version to change its pair: a relayout saves a new version after the current one.
- Never let the profile's pair change a version that exists: only the next decide, first version and
  relayout use it.
- Never save the profile from the studio with an upsert or a plain update of `user_id`: the owner's grants
  allow `font_pair` only, so save through `set_font_pair`.
