// Test helper: a VersionStore in memory, like save_version: numbered rows, a
// current pointer, and a refused parent that is no longer current.
import type { NewVersion, VersionRow, VersionStore } from "@edit-issebya/edit";

export function memoryVersions() {
  const rows: VersionRow[] = [];
  let current: string | null = null;
  const store: VersionStore = {
    async current() {
      const row = rows.find((candidate) => candidate.id === current);
      return row ? { id: row.id, number: row.number } : null;
    },
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async insert(row: NewVersion) {
      if (row.parent_id !== current) throw new Error("parent is not the current version");
      const saved = { ...row, number: rows.length + 1 };
      rows.push(saved);
      current = saved.id;
      return saved;
    },
  };
  return { rows, store, currentId: () => current };
}
