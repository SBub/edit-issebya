# Evals: the components judge against the owner's labels

**Specifications:**

- None: an owner request (a judge-only eval script for the worker).

## Overview

The owner labelled six reels by hand: which words are an ACCENT, a BIGWORD, a LIST, a QUESTION, and
which lines hold nothing. The labels live in PostHog as the dataset `owner-reels` (project 312096).
An LLM judge (prompt `reel-components-judge` in PostHog, model Sonnet 5.5) reads a reel's script and a
set of picks and answers approve or reject for each. This eval measures how often the judge agrees
with the owner, so the judge prompt can be tuned until it does.

It costs no curator call: the curator (the decide step's `reel-components` call) already ran on these
reels, and every run's answer is stored beside its version. The eval reads those answers back, labels
each pick against the owner's marks with code, asks the judge about them, and compares.

## How to run

From the repository root, on the Mac (not in the worker container), with the local stack up:

```
yarn workspace @edit-issebya/worker eval:judge --dry-run
yarn workspace @edit-issebya/worker eval:judge
yarn workspace @edit-issebya/worker eval:judge --reel 9dfd03d8 --label staging
```

- `--dry-run`: everything except the judge calls and the upload. Prints, per labelled reel, the
  curator runs found, the picks and their good and bad labels. Free.
- `--reel <id>`: only the labelled reel whose id starts like this.
- `--label <label>`: the judge prompt's label in PostHog (default `POSTHOG_PROMPT_LABEL`, else
  `production`).

It reads `apps/worker/.env.development` like the worker's other commands (`doctor`, `trace`): the
Supabase and R2 variables, `OPENROUTER_API_KEY`, and `POSTHOG_PERSONAL_API_KEY`,
`POSTHOG_PROJECT_ID`, `POSTHOG_HOST`. The personal key needs these scopes besides `llm_prompt:read`;
a missing one fails with a message naming it:

| scope                                | for                                            | needed by     |
| ------------------------------------ | ---------------------------------------------- | ------------- |
| `dataset:read`                       | the dataset's latest revision and items        | every run     |
| `llm_analytics:read`                 | finding the `judge_agreement` scorer           | a judged run  |
| `llm_analytics:write`                | creating that scorer, the first time only      | the first run |
| `offline_evaluation_ingestion:write` | creating, uploading and closing the experiment | a judged run  |

The judge calls are traced like the worker's other AI calls (a `chat` span per call, under an
`eval.judge.call` span, under one `eval.judge` root span whose trace id is the experiment's id without
dashes), exported wherever `OTEL_EXPORTER_OTLP_ENDPOINT` of the env file points. The worker container
sends its traces to local Grafana only (`app_docs/worker-container.md`), which is why the eval runs on
the Mac.

## How it works

Code: `apps/worker/src/eval-judge.ts` (the command) and `apps/worker/src/evals/`.

1. **The dataset** (`posthog-evals.ts`, `owner-marks.ts`). The latest revision of the dataset and its
   items. Each mark (seconds and words) becomes a span of word positions on the item's transcript: by
   its words first (the run starting nearest the mark's start), else by its seconds.
2. **The curator's past runs** (`curator-runs.ts`, `worker-sources.ts`). Every live `stored_files` row
   of step `decide` ending in `.ai.json`, with its version's transcript. A run belongs to a labelled
   reel when its transcript has the dataset item's words, word for word, whatever reel it is: a
   re-upload of the same footage is found by its words, never by a hard-coded id. A run of the labelled
   reel decided from another transcript is left out and counted. The picks are the last `decide`
   answer's accents, questions, big words and lists; the hook and the visuals are skipped.
3. **Labels** (`label.ts`). See below.
4. **The judge** (`judge-call.ts`). One call per labelled reel and curator run: that run's picks plus
   every owner mark as a good pick, identical picks merged, shuffled with a fixed seed and named `p1`,
   `p2`, ... so the judge cannot tell the sources apart. `{{script}}` is the script exactly as the
   curator's prompt receives it (`scriptOf`, the same preset); `{{picks}}` is a fenced JSON array of
   `{ pick, component, words, start, end, items? }`.
5. **The answer**. `{ "verdicts": [{ "pick", "verdict": "approve" | "reject", "reason", "better" }] }`,
   asked for as a strict structured output (the AI runner's `json_schema` mode, JSON mode only if the
   provider refuses the schema) and checked again in code: the same schema, exactly one verdict per
   pick sent (none missing, none twice, none for a pick not sent), and `better` null on an approve. An
   invalid answer goes back once with its reasons, as in the decide step. A second invalid answer
   fails that call: it is listed in the report and marked in the upload, and its picks are not scored.
6. **The score** (`score.ts`). A pick agrees when a good one is approved or a bad one rejected.
   Agreement overall, per component and per reel, and the confusion table.
7. **The report** (`report.ts`). One self-contained HTML page (light and dark) in
   `apps/worker/eval-output/` (gitignored: it quotes transcripts), with the tables, the failed calls
   and every disagreement: words, component, code label, verdict, reason and better.
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
owner marks accents and big words inside sections. VISUAL and the hook are not scored: the owner's
visual marks are ignored.

### What PostHog gets

- Experiment: `prompt_version` is the judge prompt (`reel-components-judge@v3`), `model_version` the
  judge's model, `application_version` the curator prompt versions judged, `dataset_revision_id` the
  revision.
- Item (one per labelled reel): `case_key` the dataset item's client id; the payload holds, per curator
  run, the picks sent (`input`), the verdicts or the failure (`output`) and the code labels
  (`expected_output`); its metadata the reel, the judge prompt version and label, the model and the
  curator prompt versions.
- Result, scorer `judge_agreement` (numeric, 0 to 1, made on the first run): the reel's agreement over
  its calls that answered; `skipped` for a reel with no stored curator run; `error`
  (`judge_answer_invalid`) when every call of the reel failed. Its metadata repeats the counts and each
  run's agreement (null for a failed call).

## Rules

- Never call the curator here (no `hook` or `decide` call, no decide step, no job): the eval reads
  stored answers only. Its only AI call is the `judge` role.
- Read-only on the database and on storage: selects and gets only. The eval's only writes are the
  judge calls, the report file and the PostHog scorer and experiment.
- Never run it against production data on a whim: a judged run costs Sonnet calls (one per labelled
  reel and curator run). Use `--dry-run` first.
- The judge prompt's wording lives only in PostHog (`reel-components-judge`), never in the repository;
  tests use the placeholder in `apps/worker/test-support/fake-prompts.ts`. It is not one of the
  worker's own prompts: never add it to `PROMPT_NAMES`, or the doctor would require it.
- Never tell the judge where a pick came from or what its label is, and never drop the shuffle or the
  merge: a judge that can tell the owner's marks apart is not measured.
- Never guess a verdict: an answer that fails the schema or the per-pick rules after the one retry
  fails its call.
- Never commit `apps/worker/eval-output/`.
- The contract with the prompt (the two variables, the pick fields, the answer's shape) changes on
  both sides together.
- The judge's model is `AI_MODELS.judge` in `apps/worker/src/ai.ts`, with its price in the price
  table; never name it elsewhere.

## Testing

Unit tests beside each module (`apps/worker/src/evals/*.test.ts`), no network and no database: mark
positions, every label rule, pick parsing from a stored AI record, the re-upload match, the answer
rules and the retry, the score, the report, the PostHog requests and the upload payload.

## Notes

- Overall agreement counts picks, so a reel with many stored curator runs weighs more; the per-reel
  table and the PostHog scorer (one value per reel) do not have that tilt.
- The owner's marks are sent in every call of a reel, so they count once per curator run.
