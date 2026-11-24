# Evals: the components judge and curator against the owner's labels

**Specifications:**

- None: an owner request (a judge-only eval script for the worker, then a curator eval on the same dataset).

## For the owner

**What the evals are for.** You labelled nine reels by hand: which words are an accent, a big word, a list, a
question or a visual, and which lines hold nothing. The curator eval measures how well the components prompt
(the curator, `reel-components` in PostHog) agrees with those labels, so a prompt change is measured before it
reaches the worker. The judge is a separate check, not part of prompt tests (see "Overview" below).

## How to run evals yourself

**Before the first run.** `apps/worker/.env.development` must hold your PostHog personal API key as
`POSTHOG_PERSONAL_API_KEY` (see `apps/worker/.env.example`), with the scopes `llm_prompt:read`,
`dataset:read`, `dataset:write`, `llm_analytics:read`, `llm_analytics:write` and
`offline_evaluation_ingestion:write`. A missing scope stops the run with a message naming it.

All commands run from the repository root, on the Mac, with the local stack up. `yarn eval` is the short
form of `yarn workspace @edit-issebya/worker eval`.

**Try a new version of the curator prompt, step by step.**

1. Open PostHog, then Prompts, then `reel-components`. Edit the text and save it as a new version.
2. Put the label `draft` on that new version. (Never move `production` yet.)
3. In the terminal, from the repository root, run the one command:

   ```
   yarn eval compare --draft
   ```

   It first prints the version numbers of both prompts, for example `prompt production: reel-components@v12`
   and `prompt draft: reel-components@v13`. Then it runs the production prompt first and your draft second.
   Both run on the same dataset revision with the same number of repeats (5 unless you say `--repeats n`),
   one after the other. If no version has the label `draft`, it stops before any paid call and tells you how
   to add the label.

4. Read the table at the end (below). Each prompt has one row.
5. If the draft wins, move the `production` label to that version in PostHog. If it does not win, leave
   `production` where it is. Nothing is ever published by the eval.

Free check first: `yarn eval compare --draft --dry-run` shows the prompt versions and the inputs and makes no
AI call. To compare production with another label, use `--label <name>` in place of `--draft`. To measure
one label alone, use `yarn eval curator` (production) or `yarn eval curator --label draft`.

**How to read the table.** Each cell is a score from 0 to 1 (1 is perfect). With repeats it shows the mean,
then the lowest and highest repeat in brackets, for example `0.62 (0.58-0.66)`. If two prompts differ by less
than their spread, the difference is noise.

| Column       | What it means                                                                      |
| ------------ | ---------------------------------------------------------------------------------- |
| Prompt       | The prompt name, version and label, for example `reel-components@v13 (draft)`.     |
| Runs ok      | Curator calls that gave a valid answer, over all calls asked, for example `43/45`. |
| Overall F1   | All components together, visuals included. A list counts as one pick.              |
| accent       | F1 of the accents against your accent marks.                                       |
| bigword      | The same for big words.                                                            |
| list (items) | The same for the items inside lists (not the lists as a whole).                    |
| question     | The same for questions.                                                            |
| visual       | The same for visuals (the places for a picture).                                   |

F1 joins two numbers: precision (how many of the curator's picks are yours) and recall (how many of your
marks the curator found). A run that fails counts as an answer with no picks: it lowers recall (its marks are
missed) and leaves precision alone (it has no picks to be wrong). So a flaky prompt scores worse, and `Runs ok`
next to the scores shows why. An empty cell (`n/a`) means there was nothing to score for it.

**Old numbers are not comparable.** The scoring changed on 2026-11-24: visuals joined the overall F1, the
list column counts items, and the judge left the curator eval. PostHog keeps the overall under the new
name `curator_f1_overall`. Every experiment from the new scoring carries the application version
`scoring-2026-11-24` (the code adds it to each upload by itself), so filter the experiments of suite
`components-curator` by that application version and ignore the older ones. Run the base again before you
compare with an old number.

**If a run stops half way** (a PostHog 409 or a scope error, say): fix the cause and run the command again.
The experiment that was open shows as failed in PostHog; ignore it. Rows already printed in the console
are from prompts that finished and were uploaded.

**Cost and time.** About $0.08 for one prompt with `--repeats 5` on the 9 reels (45 Haiku curator calls, no
judge calls), and about 12 minutes, since the calls run one after the other. A comparison is two prompts, so
about twice that.

**Where the results are.**

- The console prints one row as each prompt finishes, then the table with the dataset revision and the cost.
- `apps/worker/eval-output/curator-<time>.html`: one report per prompt, with the table, the scores by
  component and by reel, and your marks beside each run's picks (gitignored: it quotes transcripts).
- `apps/worker/eval-output/curator-compare-<time>.html`: the table of a comparison, with the path of each
  prompt's report.
- PostHog: one experiment per prompt, suite `components-curator`, with one score per column.

**The rule.** Compare on one dataset revision (printed at the top of the table and in the report). If you
change your marks in the dataset between two runs, run production again. Move the `production` label only for
a draft that clearly wins.

**Other commands.** `yarn eval judge --dry-run` (free) and `yarn eval judge` run the judge eval, which is the
judge prompt measured against your marks, not a prompt test. `yarn eval help` lists every option. Every
command first refreshes the copy of the app's data the labelled reels are read from, for any reel whose copy
is missing or out of date, and prints one line per refreshed reel. You never run a snapshot step yourself.

## Technical details

## Overview

The owner labelled nine reels by hand: which words are an ACCENT, a BIGWORD, a LIST, a QUESTION, and
which lines hold nothing. The labels live in PostHog as the dataset `owner-reels` (project 312096).
An LLM judge (prompt `reel-components-judge` in PostHog, model Haiku 5.5) reads a reel's script and a
set of picks and answers approve or reject for each. This eval measures how often the judge agrees
with the owner, so the judge prompt can be tuned until it does.

It costs no curator call: the curator (the decide step's `reel-components` call) already ran on these
reels, and every run's answer is stored beside its version. The answers are copied into the dataset by the
refresh step (below). The judge eval reads them from the item, labels each pick against the owner's
marks with code, asks the judge about them, and compares.

## The refresh step

Every eval command runs it first (`src/evals/refresh.ts`, wired by `src/eval.ts`). It is the one eval step
that reads the app's data: `public.stored_files`, `public.versions` and R2 (`evals/worker-sources.ts`), through
sources the command passes in. For each labelled reel it builds the snapshot below and compares it with the
item's. It writes a new item version only for a reel whose snapshot is stale:

- **no snapshot yet**: the item has none (`metadata.snapshot_at` or `input.curator_input` is missing);
- **a new version or curator run**: the reel's latest version, or one of its stored runs, is not among the
  item's `metadata.snapshot_source_version_ids`;
- **the curator input changed**: the input read now differs from `input.curator_input` (a new hook, an edited
  overlay, a new version that the curator input cannot be built from).

Fresh reels are not written. The eval then reads the dataset the step left, through the same PostHog client,
so it never sees a stale item. One line is printed per refreshed reel, for example
`refreshed reel 9dfd03d8: a new version or curator run`, or `snapshot: all 6 labelled reels are up to date`.
A dry run prints `would refresh` and writes nothing: the eval then reads the refreshed items in memory.

For each labelled item the refresh step writes a new item version (PostHog's `base_version` guards the write, so a stale
copy is refused). Everything already in the item is kept; these fields are added or replaced:

- `metadata.past_curator_runs`: every stored curator run decided from the item's words, whatever reel it
  belongs to (a re-upload of the same footage is copied). Each run holds its reel id, version id, version
  number, curator prompt version, its transcript and its picks as word spans. A run of the labelled reel
  decided from another transcript is left out and counted in `metadata.snapshot_differing_runs`.
- `input.curator_input`: the reel's latest version as the curator eval needs it (its transcript, head track
  and edit), the written hook and where it came from (`version` or `ai record`), the preset's id, and the
  latest run's stored intensity and target (compared, never used). Or `{ "status": "skipped", "reason" }`
  when the reel cannot be rebuilt, which the curator eval reports by name.
- `metadata.snapshot_at` and `metadata.snapshot_source_version_ids`: when the snapshot was taken and the
  version ids it read.

`yarn workspace @edit-issebya/worker eval snapshot` refreshes every selected reel whether it is stale or not
(`--dry-run` prints what it would write, `--reel <id>` narrows to the labelled reel whose id starts like this).
It is for forcing a rewrite, not a step to remember: each eval command already refreshes what is stale.

The refresh is what makes an eval current, so a change the evals should see (a new curator run on a labelled
reel, a new version of one, a new hook) needs nothing from the owner. A change to a prompt needs nothing either
(prompts are read at eval time). A refresh writes a new version of each stale item only, and the evals read the
latest revision, so an older snapshot is never mixed in.

The personal key needs `dataset:write` besides the scopes of the eval (a refusal names it).

## How to run

From the repository root, on the Mac (not in the worker container), with the local stack up:

```
yarn eval judge --dry-run
yarn eval judge
yarn eval judge --reel 9dfd03d8 --label staging
yarn eval judge --prompt-file ~/judge-draft.txt
yarn eval compare --draft --dry-run
yarn eval snapshot --dry-run
yarn eval help
```

One entry, `src/eval.ts`, routed by `src/evals/command.ts`: the options are checked before anything runs (a
label with a draft file, a repeat count out of range, an option the subcommand does not take all stop it).

- `--dry-run`: everything except the judge calls, the upload and the refresh's writes (a stale reel is listed as
  `would refresh`). Prints, per labelled reel, the
  curator runs found, the picks and their good and bad labels, and the judge calls it would make
  (one owner call per reel, one per curator run: the dry run prints the total for the current dataset). Free.
- `--reel <id>`: only the labelled reel whose id starts like this.
- `--label <label>`: the judge prompt's label in PostHog (default `POSTHOG_PROMPT_LABEL`, else
  `production`).
- `--prompt-file <path>`: a draft judge prompt read from that file instead of PostHog's. Never with
  `--label` (a draft has no PostHog version). See "Drafts".

It reads `apps/worker/.env.development` like the worker's other commands (`doctor`, `trace`):
`OPENROUTER_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST`, and the database and R2
variables the refresh step reads. The eval itself reads none of them (`eval-boundary.test.ts` enforces it). The
personal key needs these scopes besides `llm_prompt:read`; a missing one fails with a message naming it:

| scope                                | for                                            | needed by            |
| ------------------------------------ | ---------------------------------------------- | -------------------- |
| `dataset:read`                       | the dataset's latest revision and items        | every run            |
| `dataset:write`                      | a new version of each stale reel's item        | a run after a change |
| `llm_analytics:read`                 | finding the `judge_agreement` scorer           | a judged run         |
| `llm_analytics:write`                | creating that scorer, the first time only      | the first run        |
| `offline_evaluation_ingestion:write` | creating, uploading and closing the experiment | a judged run         |

The judge calls are traced like the worker's other AI calls (a `chat` span per call, under an
`eval.judge.call` span, under one `eval.judge` root span whose trace id is the experiment's id without
dashes), exported wherever `OTEL_EXPORTER_OTLP_ENDPOINT` of the env file points. The worker container
sends its traces to local Grafana only (`app_docs/worker-container.md`), which is why the eval runs on
the Mac.

Each judge and curator call is also one PostHog `$ai_generation` event (`app_docs/measurement.md`,
"AI generations"), when `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` are set in the env file: its trace
is the experiment's id, with the reel, `source` (`eval:judge`, `eval:curator`, `eval:curator-judge`),
`eval_suite`, `eval_case`, and the prompt's name and version or a draft's `prompt_draft_id`. The
judge calls carry no script and no pick (privacy mode); the curator's call sends its transcript and
its picks, as the curator's user message and answer (`app_docs/measurement.md`). Both evals flush the
events before they exit.

## How it works

Code: `apps/worker/src/eval.ts` (the wiring), `apps/worker/src/evals/command.ts` (the routing) and `apps/worker/src/evals/` (the eval and the refresh step, shared with the curator eval).

1. **The dataset** (`posthog-evals.ts`, `owner-marks.ts`). The latest revision of the dataset and its
   items. Each mark (seconds and words) becomes a span of word positions on the item's transcript: by
   its words first (the run starting nearest the mark's start), else by its seconds.
2. **The curator's past runs** (`snapshot-format.ts`, read from `metadata.past_curator_runs`). Written
   by the snapshot (`snapshot.ts`, `curator-runs.ts`): every stored curator run decided from the item's
   words, re-uploads included. The picks are the last `decide` answer's accents, questions, big words and
   lists; the hook and the visuals are skipped.
3. **Labels** (`label.ts`). See below.
4. **The judge** (`judge-call.ts`). Two kinds of call, never mixed: one call for the owner's marks of a
   reel (every mark as a good pick), and one call per curator run with only that run's picks. Within a
   call, identical picks are merged, then shuffled with a fixed seed and named `p1`, `p2`, ... so the
   judge cannot tell the picks apart by their place. A reel with no stored curator run has no script
   to judge against, so it makes no call at all (`skipped`). The call has two inputs: `script` is the
   script exactly as the curator's prompt receives it (`scriptOf`, the same preset, from the reel's
   first run's transcript); `picks` is a fenced JSON array of
   `{ pick, component, words, start, end, items? }`. A judge prompt with no placeholder is the system
   message and the two inputs are the user message's sections (`## script`, `## picks`); one that still
   holds `{{script}}` and `{{picks}}` is filled and sent as one message
   (`app_docs/decide-step.md`, "Messages").
5. **The answer**. `{ "verdicts": [{ "pick", "verdict": "approve" | "reject", "reason", "better" }] }`,
   asked for as a strict structured output (the AI runner's `json_schema` mode, JSON mode only if the
   provider refuses the schema) and checked again in code: the same schema, exactly one verdict per
   pick sent (none missing, none twice, none for a pick not sent), and `better` null on an approve. An
   invalid answer goes back once with its reasons, as in the decide step. A second invalid answer
   fails that call: it is listed in the report and marked in the upload, and its picks are not scored.
6. **The score** (`score.ts`). A pick agrees when a good one is approved or a bad one rejected.
   Agreement overall, per source (owner marks, curator picks), per component and per reel, and the
   confusion table. The owner's marks and the curator's picks are summed over both kinds of call.
7. **The report** (`report.ts`). One self-contained HTML page (light and dark) in
   `apps/worker/eval-output/` (gitignored: it quotes transcripts), with the tables (overall, by source,
   by component, by reel), the failed calls and every disagreement: words, component, code label,
   verdict, reason and better.
8. **The upload** (`run-eval.ts`). An offline experiment in PostHog, suite `components-judge`, pinned
   to the dataset revision, created with the caller's uuid before the first judge call (so a missing
   scope costs nothing), then one item per labelled reel (pinned to the dataset item's version) with
   one `judge_agreement` result, then completed. Any failure after the creation closes it as failed.

### Labels

A curator pick is good or bad by the words it shares with the owner's marks. The first rule that fits:

| label | why               | rule                                                                      |
| ----- | ----------------- | ------------------------------------------------------------------------- |
| good  | `match`           | the same component, holding at least half of the words of an owner's mark |
| bad   | `setup`           | inside a span the owner marked as `nothing`                               |
| bad   | `wrong-component` | shares a word with a mark of another component                            |
| bad   | `partial`         | the same component, but under half of the owner's mark                    |
| bad   | `extra`           | shares no word with any mark                                              |
| good  | `owner`           | the pick is the owner's own mark                                          |

Lists compare by items. An owner item is found when a curator item shares a word with it (the curator
names an item by its key words); a list is good when at least half of the owner's items are found and
at least half of its own items found one. For a list, `partial` comes before `wrong-component`. A
`sections` list (whole passages of the reel) never makes a pick inside it the wrong component: the
owner marks accents and big words inside sections. A VISUAL mark collides with nothing either, and a visual is
never sent to the judge (the judge eval ignores the owner's visual marks and the stored runs' visuals). The
hook is not scored.

### What PostHog gets

- Experiment: `prompt_version` is the judge prompt (`reel-components-judge@v3`), `model_version` the
  judge's model, `application_version` the curator prompt versions judged, `dataset_revision_id` the
  revision.
- Item (one per labelled reel): `case_key` the dataset item's client id; the payload holds, per judge
  call, its `source` (`owner` or `curator`, with the run's ids for a curator call), the picks sent
  (`input.calls`), the verdicts or the failure (`output.calls`) and the code labels
  (`expected_output.calls`); its metadata the reel, the judge prompt version and label, the model and
  the curator prompt versions, and the agreement per source: `owner_agreement` and `owner_picks`,
  `curator_agreement` and `curator_picks`, with `owner_calls` and `curator_runs` counted.
- Result, scorer `judge_agreement` (numeric, 0 to 1, made on the first run): the reel's agreement over
  its calls that answered, owner calls and curator calls together; `skipped` for a reel with no stored
  curator run; `error` (`judge_answer_invalid`) when every call of the reel failed. Its metadata repeats
  the counts and each call's agreement (null for a failed call).

## The curator eval

`eval curator` and `eval compare` run the components prompt (`reel-components`, the decide step's curator
call) on each labelled reel and score its picks against the owner's marks, by code. The judge is not part of
it: no judge call, no judge scorer. Code: `apps/worker/src/eval.ts` (the command),
`apps/worker/src/evals/run-curator.ts` (the run of one prompt), `run-compare.ts` (the prompts of a
comparison, one after the other), `curator-input.ts` (the case, rebuilt from the item's
`input.curator_input`), `curator-call.ts` (the call and its checks), `curator-score.ts` (the counts and the
`COLUMNS`), `compare-table.ts` (the table), `curator-report.ts`.

```
yarn eval compare --draft --dry-run
yarn eval compare --draft
yarn eval compare --label next --repeats 3
yarn eval curator --label draft --reel 9dfd03d8
```

- `compare --draft` (or `--label <label>`, never both, never `production`): the production prompt first, then
  the version of `reel-components` that carries the label (`--draft` is the label `draft`). Both are fetched
  from PostHog before any paid call and their versions are printed (`prompt draft: reel-components@v13`); a
  label no version carries stops the command with how to add it, and two labels on the same version print a
  note. Then each prompt runs in turn on the one dataset revision read first, with the same repeats (default 5).
  The row of each finished prompt is printed at once, and the closing table (with the cost) is printed even
  when a later prompt fails. A crash in the second prompt keeps the first's results.
- `curator [--label <label>]`: one prompt (default `production`), repeats default 1, a table of one row.
- `--dry-run`: builds every input, fetches the prompts, prints the counts and the skipped reels. No AI call,
  no upload, and for `compare` the counts once.
- `--repeats <n>`: curator calls per reel, 1 to 20, to see the variance between runs.
- `--reel <id>`: only the labelled reel whose id starts like this.

There is no prompt file: a curator prompt is tried as a labelled version in PostHog, which is also how it
reaches the worker. The judge eval keeps its own `--prompt-file` (see "Drafts").

It reads `apps/worker/.env.development` for `OPENROUTER_API_KEY` and the PostHog variables, with `llm_prompt:read`
for each label and the same dataset and experiment scopes as the judge eval (no `llm_analytics` scope beyond
making the scorers). The database and R2 variables are read by the refresh step only.

**The input.** Built per labelled reel from the item's `input.curator_input` (written by the snapshot,
below), exactly as the decide step builds the components call:

- The transcript, the head track, the edit and the hook are the snapshot's: the reel's latest version
  when the snapshot was taken. The snapshot names the reel's id and version number in the log and report.
- The script, the intensity and the target come from `decideInput` (the decide step's own function) with
  the snapshot's preset (`ISSEBYA_PRESET`, the only one the worker decides with, matched by its id).
- The hook is the version's hook overlay. A version with none takes the latest run's hook call
  (`parseHookAnswer`), and the log notes it.
- The latest run's stored intensity and target are compared with the rebuilt ones. A difference is noted
  (the log and the report), never silently corrected.
- A reel that could not be rebuilt at snapshot time is skipped and named with its reason (no stored run
  with its words, no version, a latest transcript that is not the dataset's words, a latest version that
  does not parse). A snapshot whose edit no longer parses is skipped the same way.

**The call.** Role `decide` (the decide role's model, Haiku 5.5), the same JSON schema, the same parse
(`parseDecideAnswer`), then the decide step's own check of the answer: placed over the latest version
(`editFromAnswer`, with the version's font pair for the measure). A refused answer goes back once with its reasons; a second refusal fails that run,
which is listed and not scored. The one difference from the worker is the font pair (the version's, not
the owner's profile): it changes measuring, not what the answer says.

**The score (code, labels as the judge eval's).** A pick is good when it matches an owner mark of its
component (`matchesMark`, the labels' rule). Per component (accent, bigword, list, question, visual):
precision = good picks over picks; recall = owner marks matched by a pick over owner marks; F1 of the two.
Overall and per reel the counts are summed over every run before the ratios are taken, so repeats weigh as
runs. Precision is 0 with no picks, recall is 0 with no marks, F1 is null only when there is nothing to
score. The hook is not scored (it has its own LLM call).

The list has a second score, by items (`scoreListItems`). A curator item and an owner item are paired only when
the words they share are at least half of all the words the two cover (`itemMatches`); the most alike pairs
go first, and an item is in one pair only. Curator items are the picks and owner items the marks of the usual
precision, recall and F1. A list the owner did not mark costs precision, a list the curator missed costs
recall. An owner list of level `sections` (whole passages) is left out: the curator never gives a passage as an
item. The list column of the table is this score; the report shows it as "list (items)", and notes the
whole-list counts (a list as one pick, as the overall counts it) under the table.

**A failed run** (no valid answer after the retry) scores as an answer with no picks: every owner mark of its
reel is missed (recall drops; precision has no pick to count), and it stays in every denominator. It is counted in `Runs ok`, listed in the report and marked
`error` in the upload.

**The comparison table** (`compare-table.ts`). One row per prompt: `Runs ok`, then the columns of `COLUMNS` in
`curator-score.ts`, the overall F1 first, then one per component. Each `COLUMNS` entry holds the heading, the
PostHog scorer's name and description and the counts the F1 is taken from. A repeat is one curator run of
every reel; its counts are pooled over the reels and the F1 taken. A cell is the mean of the repeats' F1 and
their lowest and highest. The dataset revision is read once per command, by the refresh step, and every
prompt of a comparison reads that revision; it is printed with the table. A new component (a SECTION)
needs its name in `COMPONENTS`, its owner marks in `parseOwnerItem`, its picks in `picksOfAnswer` and one
entry in `COLUMNS` (and `isJudged` if the judge does not know it); the table, the scorers and the report
follow.

**The report.** `apps/worker/eval-output/curator-<time>.html` (gitignored): the comparison table (one row);
the F1, precision and recall; the tables by component and by reel (the F1 range over the runs); the skipped
reels, the failed calls; and per reel the owner's marks beside each run's picks, each pick with its label.
A comparison also writes `curator-compare-<time>.html`: the table of every prompt and the path of each
prompt's report.

**PostHog.** An offline experiment per prompt, suite `components-curator`, pinned to the dataset revision.
`prompt_version` is the curator's identity (`reel-components@v<N>`), `model_version` the decide model, and
`application_version` is `SCORING_VERSION` (`scoring-2026-11-24`, in `run-curator.ts`): every upload carries
it, so the experiments made before a scoring change are told apart. Change it when what a score means
changes. One item per reel: its input (script, hook, intensity, target), its runs as sent and answered, the
owner's marks as expected output, and the metadata (the prompt version and label, the model, the scoring
version, the run counts). One result per scorer per item (0 to 1): `curator_f1_overall`,
`curator_f1_accent`, `curator_f1_bigword`, `curator_f1_list` (items), `curator_f1_question` and
`curator_f1_visual`. A result is `skipped` when nothing could be scored for it (a component the reel has no
mark and no pick of), and `error` (`curator_answer_invalid`) when every call of the reel failed.

**Prompts.** The curator prompt is read from PostHog at a label (`production`, `draft` or another), the way
the worker reads it (`app_docs/decide-step.md`, "Prompts"): a version with no `{{name}}` placeholder is the
system message and the inputs `script`, `hook`, `intensity` and `target_picks` are the user message's
sections; one with placeholders is filled and sent as one message. The eval has no prompt file: a prompt
draft is a labelled version in PostHog, which keeps the tried text and the live text in one place.

Cost: one curator call per reel per repeat (plus one retry on a refused answer); about $0.08 for the 9 reels
at `--repeats 5`, once per prompt. Run `--dry-run` first.

## Rules

- The curator eval reads the dataset items only and writes nothing to the database or to storage: no job,
  no version, no AI record. Its writes are the AI calls, the report and the PostHog experiment.
- The curator's input is the decide step's and nothing more: never the owner's marks or a
  stored answer added to the prompt. The owner's marks are scored only, never shown to the curator.
- The curator eval makes no judge call and uploads no judge score. The judge is measured by its own eval.
- The components prompt's wording lives only in PostHog (`reel-components`), never in the repository and
  never in a file: a draft is a version labelled `draft`.
- A reel that cannot be rebuilt is skipped and named in the log and the report, never guessed.
- A stored value that differs from the rebuilt one is noted, never used in its place.
- The ratios are taken after the counts are summed. The hook is not scored. A visual is scored by code only
  and never sent to the judge.
- A failed run stays in the denominators and is counted in the table, never dropped.
- Every prompt of a comparison runs on the one dataset revision read first, one after the other (parallel
  runs hit a PostHog 409), and the table prints that revision.

## Drafts

Only the judge eval takes a prompt file: the curator's drafts are labelled versions in PostHog (see "The curator eval").

A new judge prompt is tried before PostHog holds a version of it, so PostHog gets a version only for a
prompt that wins:

1. Write the draft in a local file outside the repository (the wording never lives in the repo, and
   `--prompt-file` refuses a path inside it).
2. Run the eval on it: `eval judge --prompt-file <path>`. The draft is judged in place of
   `reel-components-judge`, which is not fetched.
3. The report and the PostHog experiment record the draft as `draft:<first 12 hex of the sha256 of the
text>` (the experiment's `prompt_version`, the item's `judge_prompt_version`, label `draft`), with
   the file name (`judge_prompt_file` in the item metadata, and in the report's judge line). The same text
   always gets the same id. The judge calls' traces show the call's prompt as `draft@v0`; their
   generation events carry the id as `prompt_draft_id`.
4. Iterate on the file until the agreement is the one you want, comparing the experiments by id.
5. Only for a winner: publish the text as a new `reel-components-judge` version in PostHog, set its
   label, then run the eval with `--label <label>` to confirm the same agreement under that version.

A judge draft (`--prompt-file`) is sent the way a PostHog
version is, by the same rule (`app_docs/decide-step.md`, "Messages"): a file with no `{{name}}`
placeholder is the system message, sent unchanged and marked cacheable, and the call's inputs are the
user message; a file with placeholders is a template, filled and sent as one message. So a
system-message version of a prompt is tried as a draft before PostHog holds it, and a draft and the
version published from it run the same way. The draft id is the hash of the file's text either way.

## Rules

- The judge eval never calls the curator (no `hook` or `decide` call, no decide step, no job): it reads
  the snapshot in the items only. Its only AI call is the `judge` role. (The curator eval has its own rules.)
- Reads no database and no storage, and loads none of their modules: only the refresh step does, through
  sources the command passes in (`eval-boundary.test.ts` follows the imports). The judge eval's only writes are the judge calls, the
  report file and the PostHog scorer and experiment.
- Only the refresh step writes dataset items, and only a new version of each stale reel (`base_version`
  guarded). The evals never write one.
- Never run it against production data on a whim: a judged run costs Haiku calls (one per labelled
  reel and curator run). Use `--dry-run` first.
- The judge prompt's wording lives only in PostHog (`reel-components-judge`), never in the repository;
  tests use the placeholder in `apps/worker/test-support/fake-prompts.ts`. It is not one of the
  worker's own prompts: never add it to `PROMPT_NAMES`, or the doctor would require it.
- Never tell the judge where a pick came from or what its label is, and never drop the shuffle or the
  merge: a judge that can tell the owner's marks apart is not measured.
- Never read a draft prompt from inside the repository, and never give `--label` and `--prompt-file`
  together: the eval refuses both.
- Never put the owner's marks and a curator run's picks in one judge call: the judge would reject the
  owner's marks as duplicates of the curator's picks on the same words. A call holds one source only.
- Never guess a verdict: an answer that fails the schema or the per-pick rules after the one retry
  fails its call.
- Never commit `apps/worker/eval-output/`.
- The contract with the prompt (the two inputs `script` and `picks`, as placeholders or as the user
  message's sections, the pick fields, the answer's shape) changes on both sides together.
- Never send an eval call outside the AI runner: a draft follows the same message rule as a PostHog
  version, and every call is a generation event with the experiment as its trace.
- The judge's model is `AI_MODELS.judge` in `apps/worker/src/ai.ts`, with its price in the price
  table; never name it elsewhere.

## Testing

Unit tests beside each module (`apps/worker/src/evals/*.test.ts`), no network and no database: mark
positions, every label rule, pick parsing from a stored AI record, the re-upload match, the call
grouping (the owner's marks alone, each run's picks alone), the answer rules and the retry, the score
and its split by source, the report, the PostHog requests and the upload payload, and the draft prompt
(the refusal of a path inside the repository, the draft id, the recorded version; a draft with
placeholders sent as one message, one with none as the system message with the inputs as the user
message; the experiment as the trace of every call's generation event).

The refresh step's tests (`refresh.test.ts`: the stale check, the dry run, the forced run, the write's failure, a judge run after a refresh; `snapshot.test.ts` and the snapshot side of `curator-input.test.ts`), the command's routing (`command.test.ts`) use in-memory fakes
of the sources: the plan (re-uploads copied, a run of another transcript counted and left out, a skipped
curator input), the item update (what is kept, what is added, `base_version`, the read-back to the
evals' shape), a dry run that writes nothing, the write's failure message, and an item with no snapshot
stopping both evals before any call. `eval-boundary.test.ts` fails if an eval module reaches the database,
storage or the snapshot command through a run-time import.

The judge and curator evals' tests feed them dataset items the snapshot made from fakes
(`test-support/snapshot-fixtures.ts`), so they run from dataset-only items. The curator eval's tests use the
in-memory fixtures of `apps/worker/test-support/curator-fixtures.ts` and a scripted AI double: the case
rebuilt from the stored input (its hook, the notes on stored values, the skips), the call's one retry and its
unavailable stop, the precision, recall and F1 maths and their pooling, a dry run that makes no call,
the prompt's version and label in the experiment, the upload's results (including `error` and
`skipped`), the comparison (production then the draft label on one dataset read, a missing label, a failed run,
a later prompt's crash keeping the first row), the command's options and the report's escaping.

## Notes

- Overall agreement counts picks, so a reel with many stored curator runs weighs more; the per-reel
  table and the PostHog scorer (one value per reel) do not have that tilt.
- The owner's marks are judged once per reel (one call), so they weigh once; each curator run's picks
  weigh with their run. The agreement by source shows the two apart.
