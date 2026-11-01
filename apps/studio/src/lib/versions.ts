import type { Check, EditInputs } from "@edit-issebya/edit";

// Named columns, never "*". The edit itself is in R2 at r2_key; the row holds
// its metadata.
export const VERSION_COLUMNS =
  "id, reel_id, number, parent_id, restored_from_id, request, model, prompt_version, change_summary, checks, inputs, r2_key, created_at";

export interface VersionRow {
  id: string;
  reel_id: string;
  number: number;
  parent_id: string | null;
  restored_from_id: string | null;
  request: string | null;
  model: string | null;
  prompt_version: string | null;
  change_summary: string | null;
  checks: Check[];
  inputs: EditInputs;
  r2_key: string;
  created_at: string;
}
