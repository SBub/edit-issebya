import { z } from "zod";
import { PLAIN_LINE, type Pick } from "./answer.ts";
import { Component } from "./base.ts";
import type { HookChoice } from "../engine-input.ts";
import type { Preset } from "../preset.ts";
import { type OverlayItem, issueReasons } from "../schema.ts";
import { VARIANTS } from "../variants.ts";

// The hook as placed and saved: its final full stops and ellipses (".", "...", "…", with any
// spaces after them) taken off, since a hook reads like a post and never ends with a dot; "?" and
// "!" stay, and so does a dot inside. Applied to every hook the answer writes, the owner's exact
// words too.
export function stripHookStop(text: string): string {
  return text.replace(/[\s.…]+$/u, "");
}

// The written hook's text, the same rules for the hook call's answer and for the components'
// answer's hook: one line of plain words (no line break, no tag), at most the preset's characters
// and words, with at least one letter or digit once the final stop is taken off.
function hookTextSchemaFor(preset: Preset) {
  const { maxWords, maxCharacters } = preset.pace.hook;
  return z
    .string()
    .min(1)
    .max(maxCharacters, { message: `a hook has at most ${maxCharacters} characters` })
    .regex(PLAIN_LINE, { message: "a hook is one line of plain text" })
    .refine((text) => /[\p{L}\p{N}]/u.test(stripHookStop(text)), {
      message: "a hook needs words",
    })
    .refine((text) => text.trim().split(/\s+/).length <= maxWords, {
      message: `a hook has at most ${maxWords} words`,
    });
}

// The hook call's answer (HOOK, its own call): `{ "text": "..." }` and nothing else, the text
// checked by `hookTextSchemaFor`.
export function hookAnswerSchemaFor(preset: Preset) {
  return z.strictObject({ text: hookTextSchemaFor(preset) });
}

// The hook answer's JSON Schema, the structured output of the hook call (the same draft-07 form
// as `decideJsonSchema`).
export function hookJsonSchema(preset: Preset): Record<string, unknown> {
  return z.toJSONSchema(hookAnswerSchemaFor(preset), {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

// The hook answer checked again by Zod, with readable reasons; the text is returned as it is
// placed (`stripHookStop`), never refused for a final dot.
export function parseHookAnswer(
  json: unknown,
  preset: Preset,
): { ok: true; text: string } | { ok: false; reasons: string[] } {
  const result = hookAnswerSchemaFor(preset).safeParse(json);
  if (!result.success) return { ok: false, reasons: issueReasons(json, result.error.issues) };
  return { ok: true, text: stripHookStop(result.data.text) };
}

// The one written line at the start of the reel, typed letter by letter (its own AI call).
export class Hook extends Component {
  readonly name = "HOOK" as const;
  readonly looks = [VARIANTS["hook/typed"]];
  readonly order = 0;

  // Its own AI call, described as data: the role, the prompt it fetches by name (the wording lives
  // in PostHog only), its answer's JSON Schema and how that answer is checked. The worker reads
  // this and runs the call itself.
  readonly ownCall = {
    role: "hook" as const,
    prompt: "reel-hook",
    schema: hookJsonSchema,
    parse: parseHookAnswer,
  };

  // The hook of a version: the text of the last hook overlay that has one (none: no hook).
  override readBack(items: readonly OverlayItem[]): HookChoice[] {
    const written = items.filter((item) => item.text);
    const last = written.at(-1);
    return last ? [{ text: last.text! }] : [];
  }

  override picks(answer: object): Pick[] {
    const hook = (answer as { hook?: HookChoice | null }).hook;
    return hook ? [{ ref: "hook", item: "hook", from: "", to: "", text: hook.text }] : [];
  }

  override trace(pick: Pick): string {
    return `hook "${pick.text}"`;
  }
}
