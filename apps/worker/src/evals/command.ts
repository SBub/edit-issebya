import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { checkPromptSource } from "./draft-prompt.ts";

// THE EVAL COMMAND'S ROUTING (app_docs/evals.md, "How to run"): one entry,
// `yarn workspace @edit-issebya/worker eval <command> [options]`, the command
// being judge, curator or snapshot.
// Pure: it parses and checks the options, then hands the command to the
// caller's handler. The wiring is in `src/eval.ts`.

const MAX_REPEATS = 20;

export const EVAL_USAGE = `usage: yarn workspace @edit-issebya/worker eval <command> [options]

  judge      the components judge against the owner's labels (app_docs/evals.md)
               [--dry-run] [--reel <id>] [--label <label> | --prompt-file <path>]
  curator    the components curator on the owner's reels, scored and judged
               [--dry-run] [--reel <id>] [--repeats <n>]
               [--curator-label <label> | --curator-prompt-file <path>]
               [--judge-label <label> | --judge-prompt-file <path>]
  snapshot   refresh every labelled reel's snapshot now, stale or not
               [--dry-run] [--reel <id>]

Every command refreshes the stale snapshots first (printing one line per reel).`;

export type EvalCommand =
  | { kind: "help" }
  | { kind: "judge"; dryRun: boolean; reel?: string; label?: string; promptFile?: string }
  | {
      kind: "curator";
      dryRun: boolean;
      reel?: string;
      repeats: number;
      curatorLabel?: string;
      curatorPromptFile?: string;
      judgeLabel?: string;
      judgePromptFile?: string;
    }
  | { kind: "snapshot"; dryRun: boolean; reel?: string };

export interface EvalHandlers {
  help(): void | Promise<void>;
  judge(command: Extract<EvalCommand, { kind: "judge" }>): Promise<void>;
  curator(command: Extract<EvalCommand, { kind: "curator" }>): Promise<void>;
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
  "curator-label"?: string;
  "curator-prompt-file"?: string;
  "judge-label"?: string;
  "judge-prompt-file"?: string;
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

function repeatsOf(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEATS) {
    throw new Error(`evals: --repeats must be a whole number from 1 to ${MAX_REPEATS}`);
  }
  return count;
}

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
      ...(values.reel !== undefined ? { reel: values.reel } : {}),
      ...(values.label !== undefined ? { label: values.label } : {}),
      ...(values["prompt-file"] !== undefined ? { promptFile: values["prompt-file"] } : {}),
    };
  }
  if (name === "curator") {
    const values = parseOptions<CuratorValues>(rest, {
      "dry-run": DRY_RUN,
      reel: { type: "string" },
      repeats: { type: "string" },
      "curator-label": { type: "string" },
      "curator-prompt-file": { type: "string" },
      "judge-label": { type: "string" },
      "judge-prompt-file": { type: "string" },
    });
    checkPromptSource({
      label: values["curator-label"],
      promptFile: values["curator-prompt-file"],
    });
    checkPromptSource({ label: values["judge-label"], promptFile: values["judge-prompt-file"] });
    return {
      kind: "curator",
      dryRun: values["dry-run"],
      repeats: repeatsOf(values.repeats),
      ...(values.reel !== undefined ? { reel: values.reel } : {}),
      ...(values["curator-label"] !== undefined ? { curatorLabel: values["curator-label"] } : {}),
      ...(values["curator-prompt-file"] !== undefined
        ? { curatorPromptFile: values["curator-prompt-file"] }
        : {}),
      ...(values["judge-label"] !== undefined ? { judgeLabel: values["judge-label"] } : {}),
      ...(values["judge-prompt-file"] !== undefined
        ? { judgePromptFile: values["judge-prompt-file"] }
        : {}),
    };
  }
  if (name === "snapshot") {
    const values = parseOptions<SnapshotValues>(rest, {
      "dry-run": DRY_RUN,
      reel: { type: "string" },
    });
    return {
      kind: "snapshot",
      dryRun: values["dry-run"],
      ...(values.reel !== undefined ? { reel: values.reel } : {}),
    };
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
    case "snapshot":
      return handlers.snapshot(command);
  }
}
