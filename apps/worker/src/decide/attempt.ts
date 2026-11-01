import {
  type CheckResult,
  type DecideAnswer,
  type DecideContext,
  type Edit,
  type HeadTrack,
  type Measurer,
  build,
  decideAnswerSchema,
  editFromAnswer,
  glossaryCheck,
  parseEdit,
} from "@edit-issebya/edit";

export interface AttemptInput {
  // The AI's answer, as it came.
  output: unknown;
  context: DecideContext;
  // The parent version's fingerprints.
  inputs: Edit["inputs"];
  headTrack: HeadTrack;
  measurer: Measurer;
}

export type Attempt =
  | { ok: true; answer: DecideAnswer; edit: Edit; checks: CheckResult }
  | { ok: false; reasons: string[] };

// Zod's issue type, without a direct dependency on zod.
type Issue = NonNullable<
  ReturnType<ReturnType<typeof decideAnswerSchema>["safeParse"]>["error"]
>["issues"][number];

function where(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "answer";
}

// One line per issue; a union names what each of its shapes refused.
function describe(issue: Issue): string {
  if (issue.code === "invalid_union" && issue.errors.length > 0) {
    const shapes = issue.errors.map((branch) =>
      branch.map((inner) => `${where(inner.path)}: ${inner.message}`).join(", "),
    );
    return `schema: ${where(issue.path)}: matches no allowed shape (${shapes.join(" | ")})`;
  }
  return `schema: ${where(issue.path)}: ${issue.message}`;
}

// One answer through every check, in order: the per-reel schema, the edit
// format against the transcript and the preset, the builder's checks
// (safe box, face, sound gap) and the glossary. A passing attempt has no
// reasons at all; its checks are the builder's and the glossary's.
export function evaluateAttempt({
  output,
  context,
  inputs,
  headTrack,
  measurer,
}: AttemptInput): Attempt {
  const parsed = decideAnswerSchema(context).safeParse(output);
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.map(describe) };
  const answer = parsed.data;
  const { transcript, preset } = context;
  let edit: Edit;
  try {
    edit = parseEdit(editFromAnswer(answer, inputs), { transcript, preset });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reasons: message.split("\n").filter((line) => line !== "invalid edit:") };
  }
  const built = build({ edit, transcript, headTrack, preset, measurer });
  const reasons = [...built.checks.reasons, ...glossaryCheck(edit, preset).reasons].sort();
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, answer, edit, checks: { ok: true, reasons: [] } };
}
