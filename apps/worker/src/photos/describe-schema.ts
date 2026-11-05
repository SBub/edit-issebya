import { z } from "zod";

const MAX_DESCRIPTION_CHARS = 200;
const MIN_TAGS = 3;
const MAX_TAGS = 8;

// A short lowercase word or phrase: letters, digits, spaces and hyphens.
const TAG = /^[a-z0-9][a-z0-9 -]{0,29}$/;

// What the model answers for one photo: one plain sentence and 3 to 8
// lowercase tags, nothing else.
const describeAnswerSchema = z.strictObject({
  description: z.string().min(1).max(MAX_DESCRIPTION_CHARS),
  tags: z.array(z.string().regex(TAG)).min(MIN_TAGS).max(MAX_TAGS),
});

export type DescribeAnswer = z.infer<typeof describeAnswerSchema>;

// The answer's JSON Schema, the structured output the AI runner asks for:
// draft-07, like decide's.
export const describeJsonSchema = z.toJSONSchema(describeAnswerSchema, {
  target: "draft-07",
  io: "output",
  reused: "inline",
}) as Record<string, unknown>;

function where(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "answer" : path.map(String).join(".");
}

// The answer, or readable reasons it was refused (where, and Zod's message),
// the shape decide's reasons have.
export function parseDescribeAnswer(
  json: unknown,
): { ok: true; answer: DescribeAnswer } | { ok: false; reasons: string[] } {
  const result = describeAnswerSchema.safeParse(json);
  if (result.success) return { ok: true, answer: result.data };
  return {
    ok: false,
    reasons: result.error.issues.map((issue) => `${where(issue.path)}: ${issue.message}`),
  };
}
