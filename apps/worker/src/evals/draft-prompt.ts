import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

// THE DRAFT JUDGE PROMPT (app_docs/evals.md, "Drafts"): a judge template read
// from a local file outside the repository, judged by the eval before any
// PostHog version of it exists. Its identity is `draft:<hash>`, not a version.

export interface DraftPrompt {
  // The template, as the judge call fills it.
  text: string;
  // The file's base name, recorded beside the identity.
  file: string;
  // `draft:` and the first 12 hex digits of the text's sha256.
  id: string;
}

export function draftId(text: string): string {
  return `draft:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

// Whether `path` is `root` or inside it (a sibling that only starts with the
// same name is not inside).
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// `--label` names a PostHog version, `--prompt-file` a draft that has none: never both.
export function checkPromptSource({ label, promptFile }: { label?: string; promptFile?: string }) {
  if (label !== undefined && promptFile !== undefined) {
    throw new Error(
      "evals: --label and --prompt-file are mutually exclusive: a draft is not a PostHog version, so it has no label",
    );
  }
}

// Reads the draft. A file inside the repository is refused before it is read:
// prompt wording never lives in the repository.
export async function readDraftPrompt({
  path,
  repoRoot,
  read,
}: {
  path: string;
  repoRoot: string;
  read: (path: string) => Promise<string>;
}): Promise<DraftPrompt> {
  const full = resolve(path);
  if (isInside(repoRoot, full)) {
    throw new Error(
      `evals: --prompt-file ${path} is inside the repository: prompt wording never lives in the repository, keep the draft in a file outside it`,
    );
  }
  const text = await read(full);
  if (text.trim() === "") throw new Error(`evals: --prompt-file ${path} is empty`);
  return { text, file: basename(full), id: draftId(text) };
}
