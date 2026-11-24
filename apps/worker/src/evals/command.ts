import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { checkPromptSource } from "./draft-prompt.ts";

// THE EVAL COMMAND'S ROUTING (app_docs/evals.md, "How to run"): one entry,
// `yarn eval <command> [options]` (the root script of
// `yarn workspace @edit-issebya/worker eval`), the command being judge,
// curator, compare or snapshot.
// Pure: it parses and checks the options, then hands the command to the
// caller's handler. The wiring is in `src/eval.ts`.

const MAX_REPEATS = 20;
// `compare` measures a prompt on several repeats by default: one repeat cannot
// tell a better prompt from a lucky run.
const COMPARE_REPEATS = 5;
// The label a new version of the curator prompt carries while it is tried.
const DRAFT_LABEL = "draft";

export const EVAL_USAGE = `usage: yarn eval <command> [options]

  compare    the components curator at the production label, then at another label, one table
               --draft | --label <label>   [--repeats <n>, default ${COMPARE_REPEATS}] [--dry-run] [--reel <id>]
  curator    the components curator at one label, scored against the owner's marks
               [--label <label>, default production] [--repeats <n>] [--dry-run] [--reel <id>]
  judge      the components judge against the owner's labels (app_docs/evals.md)
               [--dry-run] [--reel <id>] [--label <label> | --prompt-file <path>]
  snapshot   refresh every labelled reel's snapshot now, stale or not
               [--dry-run] [--reel <id>]

  --draft is --label ${DRAFT_LABEL}: the version of the reel-components prompt labelled ${DRAFT_LABEL} in PostHog.

Every command refreshes the stale snapshots first (printing one line per reel).`;

export type EvalCommand =
  | { kind: "help" }
  | { kind: "judge"; dryRun: boolean; reel?: string; label?: string; promptFile?: string }
  | { kind: "curator"; dryRun: boolean; reel?: string; repeats: number; label: string }
  // The production prompt first, then the prompt at `label`.
  | { kind: "compare"; dryRun: boolean; reel?: string; repeats: number; label: string }
  | { kind: "snapshot"; dryRun: boolean; reel?: string };

export interface EvalHandlers {
  help(): void | Promise<void>;
  judge(command: Extract<EvalCommand, { kind: "judge" }>): Promise<void>;
  curator(command: Extract<EvalCommand, { kind: "curator" }>): Promise<void>;
  compare(command: Extract<EvalCommand, { kind: "compare" }>): Promise<void>;
  snapshot(command: Extract<EvalCommand, { kind: "snapshot" }>): Promise<void>;
}

const DRY_RUN = { type: "boolean", default: false } as const;

// The parsed values of one subcommand: its options, typed as the call declares them.
interface JudgeValues {
  "dry-run": boolean;
  reel?: string;
  label?: string;
  "prompt-file"?: string;
}
interface CuratorValues {
  "dry-run": boolean;
  reel?: string;
  repeats?: string;
  label?: string;
}
interface CompareValues extends CuratorValues {
  draft: boolean;
}
interface SnapshotValues {
  "dry-run": boolean;
  reel?: string;
}

function parseOptions<V>(args: readonly string[], options: ParseArgsOptionsConfig): V {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false })
      .values as V;
  } catch (error) {
    throw new Error(`evals: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function repeatsOf(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEATS) {
    throw new Error(`evals: --repeats must be a whole number from 1 to ${MAX_REPEATS}`);
  }
  return count;
}

const reelOf = (values: { reel?: string }) =>
  values.reel !== undefined ? { reel: values.reel } : {};

// The command and its checked options, or a thrown error that says what is wrong.
export function parseEvalCommand(argv: readonly string[]): EvalCommand {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { kind: "help" };
  }
  if (name === "judge") {
    const values = parseOptions<JudgeValues>(rest, {
      "dry-run": DRY_RUN,
      reel: { type: "string" },
      label: { type: "string" },
      "prompt-file": { type: "string" },
    });
    checkPromptSource({ label: values.label, promptFile: values["prompt-file"] });
    return {
      kind: "judge",
      dryRun: values["dry-run"],
      ...reelOf(values),
      ...(values.label !== undefined ? { label: values.label } : {}),
      ...(values["prompt-file"] !== undefined ? { promptFile: values["prompt-file"] } : {}),
    };
  }
  if (name === "curator") {
    const values = parseOptions<CuratorValues>(rest, {
      "dry-run": DRY_RUN,
      reel: { type: "string" },
      repeats: { type: "string" },
      label: { type: "string" },
    });
    return {
      kind: "curator",
      dryRun: values["dry-run"],
      repeats: repeatsOf(values.repeats, 1),
      label: values.label ?? "production",
      ...reelOf(values),
    };
  }
  if (name === "compare") {
    const values = parseOptions<CompareValues>(rest, {
      "dry-run": DRY_RUN,
      reel: { type: "string" },
      repeats: { type: "string" },
      label: { type: "string" },
      draft: { type: "boolean", default: false },
    });
    if (values.draft === (values.label !== undefined)) {
      throw new Error(
        `evals: compare needs exactly one of --draft (the version labelled ${DRAFT_LABEL}) and --label <label>`,
      );
    }
    const label = values.label ?? DRAFT_LABEL;
    if (label === "production") {
      throw new Error("evals: compare already runs production first: give it another label");
    }
    return {
      kind: "compare",
      dryRun: values["dry-run"],
      repeats: repeatsOf(values.repeats, COMPARE_REPEATS),
      label,
      ...reelOf(values),
    };
  }
  if (name === "snapshot") {
    const values = parseOptions<SnapshotValues>(rest, {
      "dry-run": DRY_RUN,
      reel: { type: "string" },
    });
    return { kind: "snapshot", dryRun: values["dry-run"], ...reelOf(values) };
  }
  throw new Error(`evals: unknown command ${name}\n\n${EVAL_USAGE}`);
}

// Parses the arguments and calls the one handler they name.
export async function runEvalCommand(
  argv: readonly string[],
  handlers: EvalHandlers,
): Promise<void> {
  const command = parseEvalCommand(argv);
  switch (command.kind) {
    case "help":
      return handlers.help();
    case "judge":
      return handlers.judge(command);
    case "curator":
      return handlers.curator(command);
    case "compare":
      return handlers.compare(command);
    case "snapshot":
      return handlers.snapshot(command);
  }
}
