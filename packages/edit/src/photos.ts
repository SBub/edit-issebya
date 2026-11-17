import type { Edit } from "./schema.ts";

// The owner's library photos in an edit (app_docs/photo-library.md): a VISUAL
// may show one in place of its stand-in picture. A version names each photo
// by id (`inputs.photos`); the preview signs its large copy and the render
// downloads it, both from the photo's own `photos` row.

// A library photo as a VISUAL holds it: its id and its size in pixels, the
// `photos` row's (`width`, `height`), so the card takes its aspect.
export interface EditPhoto {
  id: string;
  width: number;
  height: number;
}

// Where the page looks for a photo's large copy, inside the project.
export function photoPath(photoId: string): string {
  return `photos/${photoId}.jpg`;
}

// The photos the VISUALs of an edit show, by id, sorted, each once.
export function photoIdsOf(edit: Pick<Edit, "tracks">): string[] {
  const ids = new Set<string>();
  for (const item of edit.tracks.behind ?? []) {
    if (item.kind === "visual" && item.photo) ids.add(item.photo.id);
  }
  return [...ids].sort();
}

// The edit with `inputs.photos` written from its tracks: the photos its
// VISUALs show, or no field when none does.
export function withPhotoInputs(edit: Edit): Edit {
  const ids = photoIdsOf(edit);
  const inputs = { ...edit.inputs };
  delete inputs.photos;
  return { ...edit, inputs: ids.length > 0 ? { ...inputs, photos: ids } : inputs };
}
