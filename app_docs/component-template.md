# Component template: one class per component

Status: approved plan, in progress (step 0 done). The next pull requests follow the steps below.

Words used here. A **component** is a meaning the curator (the AI call that reads the transcript)
picks: ACCENT, QUESTION, BIGWORD, VISUAL, LIST, and HOOK (its own AI call); CAPTION is placed from
the transcript. A **look** (in code: a variant) is how a component appears. A **class** is a
template in code: the base class `Component` gives every part a sensible default, and a subclass
fills in or replaces only what differs. The **registry** is one list, `COMPONENTS`, with one
instance of each subclass. The rest of the code loops over it.

## The problem

A component has no single home. Its facts are repeated in many files as "if it is an accent do
this" branches: about 150 lines in 25 files name one specific component. The SECTION branch showed
what one new component costs: 30 files, 958 lines. Two things were left out of it because nothing
forced them (the studio cannot move or edit the number; the evals do not know SECTION exists).

The goal: adding a component is one new name, one subclass, one line in `COMPONENTS` and one line
in the evals' table. If any is forgotten the code does not compile.

## Decisions

- **One list of names**, `COMPONENT_NAMES` in `packages/edit/src/component-defs/names.ts`, with
  today's seven values (`HOOK`, `ACCENT`, `QUESTION`, `BIGWORD`, `VISUAL`, `LIST`, `CAPTION`) and a
  type taken from it. A constant list, not a TypeScript `enum` (`erasableSyntaxOnly` forbids it, and
  the codebase already does it this way). SECTION joins in step 6 only.
- **Stored names stay.** The answer fields (`big_words`), the dataset keys (`accent`, `bigword`) and
  the storage kinds (`word`; `accent` for a question) cannot be renamed: reels, past runs and the
  AI's schema use them. Each is written once, beside the name it maps to. No saved version is
  rewritten.
- **The base class** `Component` (in `packages/edit/src/component-defs/base.ts`) has `name`,
  `answer` (the answer's shape), `looks` (the first is the default), and defaults for `stored`,
  `order`, `whenLeftOut`, `owner` (move, resize, rotate, edit text), `validate`, `picks`, `readBack`,
  `text`, `span`, `place`, `owns`, `label` and `trace`. A default that depends on `name` is a getter
  or a method, never a plain field.
- **Subclasses are one level deep.** A method goes into the base only when two or more components
  need it. Prompt wording is never in a class (it stays in PostHog). The one-line meaning of a
  component is a code comment above its class, not a field.
- **The registry** is `Record<ComponentName, Component>`: a name with no class does not compile.
- **LIST, HOOK, VISUAL, BIGWORD and CAPTION** are subclasses that call their existing placement
  code unchanged. Rewriting LIST's stack onto the plain text path is a separate, later job.
- **Three limits.** The hook's AI call stays in the worker (`Hook` declares `ownCall`; the worker
  runs it). Captions are still placed in their own last pass. How a look draws itself stays in the
  look and the builder.
- **Evals are a separate table, not part of the class.** `apps/worker/src/evals/scorers.ts` holds
  `SCORERS: Record<ComponentName, Scorer | null>`, one line per name (`null` for HOOK and CAPTION).
  A forgotten line is a compile error. The eval reads picks through `COMPONENTS[name].picks`. The
  evals depend on the app code, never the other way round. Nothing in PostHog is renamed.
- **Folder**: `packages/edit/src/component-defs/` (not `components`, which exists with another job).
  Looks stay in `variants.ts`. No new package.

## Steps

Each step is its own pull request and changes nothing a viewer or the AI can see.

| Step | What                                                                                                                                                                                                       | Proof nothing changed                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0    | Freeze tests (below). Done.                                                                                                                                                                                | they pass on `develop` before anything moves                                       |
| 1    | Names and identity: `ComponentName`, base class, seven subclasses with `name`, `looks`, `stored`, `order`, `owns`; `COMPONENTS`. The hand-kept lists (except the evals') read them.                        | freeze tests, typecheck                                                            |
| 2    | Answer: `answer`, `validate`, `picks`, `readBack`, `trace`. The schema, `EngineInput`, `choicesOf`, the empty answers and the decision trace loop over `COMPONENTS`. `Hook.ownCall` is read by the worker. | the schema snapshot is identical; decide tests                                     |
| 3    | Engine: `text`, `span`, `place`, `whenLeftOut`. The base `place` is today's accent path; the others call their existing functions. `placeExtra`'s `if` chain goes. Risky: split per component.             | placed edits and notes identical; golden pages                                     |
| 4    | Studio: `owner`, `label`. The Edit tool, saved edits, carry-over and the timeline read them.                                                                                                               | all `owner-edit*` specs unchanged and green                                        |
| 5    | Evals' table (`SCORERS`). `COMPONENTS`, `JUDGED_COMPONENTS`, the dataset schema and `COLUMNS` are built from it.                                                                                           | the eval scoring freeze unchanged                                                  |
| 6    | SECTION: `"SECTION"` in the names, the `Section` class, the `section/number` look, one line each in `COMPONENTS` and `SCORERS`, dataset marks, docs, and the prompt version in PostHog once a draft wins.  | the SECTION branch's tests reused, plus a new spec for moving and editing a number |

Docs change inside each step (a later doc `app_docs/components.md`, "how to add a component").

## Step 0: the freeze tests

They save today's output byte for byte, so later steps can prove nothing moved. None holds prompt
wording: only answer shapes, word ids, times and boxes. A deliberate change to any of these outputs
is a decision: refresh with `-u` and say why in the commit. Refreshing the edit freeze means
re-running the worker's decision-trace and the studio's freeze tests, which read its files. A new
fixture legitimately extends `choices-of-fixtures.json` and `every-variants.json`.

- `packages/edit/src/component-freeze.test.ts`, files in `packages/edit/src/testdata/freeze/`: the
  answer JSON schema sent to the AI (`decide-answer.schema.json`) and the hook's
  (`hook-answer.schema.json`); one answer using every component placed on the reference reel
  (`every-input.json`, `every-tracks.json`, `every-record.json` the engine notes,
  `every-variants.json`); the placed components and the owner's edit rights on each
  (`every-components.json`, `every-owner-rights.json`); the picks read back from every stored fixture
  version (`choices-of-fixtures.json`). The built pages are already frozen by the golden pages.
- `apps/studio/src/lib/component-freeze.test.ts`: for each placed component of that answer, the Edit
  tool's label, list line, `canEditText` and `canRewrap`, and `scaledVisual` (`lib/testdata`).
- `apps/worker/src/decide/run-decide.test.ts` (one test): the hook's own AI call as the worker makes it:
  role, prompt name and version, and the answer schema (`apps/worker/src/testdata/hook-call-freeze.json`).
- `apps/worker/src/decision-trace-freeze.test.ts`: the decision trace and the script of that answer
  and record.
- `apps/worker/src/evals/score-freeze.test.ts`: fixed owner marks and picks (word indexes) through
  the labels, the per-run score and every column of the table, per column counts and F1
  (`testdata/score-freeze.json`).

## Rules

- Never rename a stored name (answer field, dataset key, storage kind) in this plan.
- Never put prompt wording in a class, a freeze file or this doc.
- A step that changes a freeze file's content is not a refactor: it changes the rule here first.
- Never add an enum; a constant list with a derived type.
- Never add a method to the base class that only one component needs.
- Adding or removing a component by hand in the studio is out of scope (GitHub issue #230).

## Owner's answers (2026-11-24)

All suggestions agreed:

1. A section number is edited as any short text, up to 12 characters, and it changes only that one number.
2. Each section number is moved on its own first; "same place for all" later if missed.
3. The old "section list" marks move to a new `section` field in a new dataset revision; SECTION is
   scored by code only at first (as VISUAL is), the judge does not learn it yet.
4. LIST, HOOK and VISUAL become subclasses that call their existing placement code unchanged.
5. SECTION's numbers ("2 to 4 parts", "shown 1.5 seconds") are general at first, not per tenant.
6. Order of work: merge `feat/eval-component-scores` (done), steps 0 to 5, then SECTION.
