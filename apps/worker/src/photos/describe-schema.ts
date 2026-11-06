import { z } from "zod";

const MAX_DESCRIPTION_CHARS = 200;
const MIN_TAGS = 3;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 30;

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

// What a description cut ends on after its last word: spaces and the marks
// that leave a clause open (a comma, a colon, a dash, an opening bracket or
// quote).
const OPEN_END = /[\s,;:\-\u2013\u2014(\[{"'\u201c\u2018]+$/u;

// A description cut to `max` characters, never by an AI call: at the last
// sentence end (". ", "! ", "? ") within the limit when one keeps at least
// half of it, else at the last word boundary within the limit with the open
// marks after the last word taken off, never mid-word; one word longer than
// the limit is cut hard. A description within the limit comes back as is.
export function shortenDescription(text: string, max = MAX_DESCRIPTION_CHARS): string {
  if (text.length <= max) return text;
  // The space after a sentence end or a word may sit just past the limit.
  const head = text.slice(0, max + 1);
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  if (sentenceEnd + 1 >= max / 2) return text.slice(0, sentenceEnd + 1);
  const space = head.search(/\s\S*$/u);
  const words = space > 0 ? text.slice(0, space).replace(OPEN_END, "") : "";
  return words.length > 0 ? words : text.slice(0, max);
}

// The answer as checked: an over-long description shortened
// (`shortenDescription`), and tags over 30 characters dropped and only the
// first 8 kept, so a long answer costs no second call. Anything else is left
// for the schema to refuse (an empty description, fewer than 3 tags left).
function trimmed(json: unknown): unknown {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return json;
  const answer = { ...(json as Record<string, unknown>) };
  if (typeof answer.description === "string") {
    answer.description = shortenDescription(answer.description);
  }
  if (Array.isArray(answer.tags)) {
    answer.tags = answer.tags
      .filter((tag) => typeof tag !== "string" || tag.length <= MAX_TAG_CHARS)
      .slice(0, MAX_TAGS);
  }
  return answer;
}

// The answer (shortened where it ran long, `trimmed`), or readable reasons it
// was refused (where, and Zod's message), the shape decide's reasons have.
export function parseDescribeAnswer(
  json: unknown,
): { ok: true; answer: DescribeAnswer } | { ok: false; reasons: string[] } {
  const result = describeAnswerSchema.safeParse(trimmed(json));
  if (result.success) return { ok: true, answer: result.data };
  return {
    ok: false,
    reasons: result.error.issues.map((issue) => `${where(issue.path)}: ${issue.message}`),
  };
}
