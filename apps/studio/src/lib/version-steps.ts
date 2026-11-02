// Undo and Redo on the reel page move the shown version between the saved
// versions only: they never create a version or queue a job ("Go back to
// this" stays the only way to make an older version current).

interface Numbered {
  id: string;
  number: number;
}

// The owner's pick, remembered with the current version it was made for.
export interface VersionSelection {
  id: string;
  forCurrent: string | null;
}

function byNumber<T extends Numbered>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => a.number - b.number);
}

function step(versions: readonly Numbered[], shownId: string | null, by: 1 | -1): string | null {
  const ordered = byNumber(versions);
  const index = ordered.findIndex((version) => version.id === shownId);
  if (index < 0) return null;
  return ordered[index + by]?.id ?? null;
}

// The version saved just before the shown one (by number); null at the first
// version or when the shown id is unknown.
export function previousVersionId(
  versions: readonly Numbered[],
  shownId: string | null,
): string | null {
  return step(versions, shownId, -1);
}

// The version saved just after the shown one; null at the newest or when the
// shown id is unknown.
export function nextVersionId(
  versions: readonly Numbered[],
  shownId: string | null,
): string | null {
  return step(versions, shownId, 1);
}

// The version the page shows, derived during render: the owner's pick while
// the current version is still the one it was made for, otherwise the
// current version (a new current version arriving through Realtime resets
// the view with no effect).
export function shownVersionId(
  selection: VersionSelection | null,
  currentId: string | null,
): string | null {
  if (selection && selection.forCurrent === currentId) return selection.id;
  return currentId;
}
