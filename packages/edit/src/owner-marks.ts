import type { Edit } from "./schema.ts";

// THE OWNER'S MARKS (`edit.owner`, app_docs/owner-edits.md): which items the
// owner placed by hand and which texts the owner wrote, kept in the version so
// a later re-layout or Start over can carry them (`owner-carry.ts`). An item's
// mark is its id; a list level's text is `<id>/<role>`.

export function levelMark(id: string, role: string): string {
  return `${id}/${role}`;
}

// The edit with more marks: sorted, each once. The edit itself with none.
export function withOwnerMarks(
  edit: Edit,
  more: { placed?: readonly string[]; texts?: readonly string[] },
): Edit {
  const placed = [...new Set([...(edit.owner?.placed ?? []), ...(more.placed ?? [])])].sort();
  const texts = [...new Set([...(edit.owner?.texts ?? []), ...(more.texts ?? [])])].sort();
  if (placed.length === 0 && texts.length === 0) return edit;
  return { ...edit, owner: { placed, texts } };
}
