// Field names for the call form's analytics events (see app_docs/analytics.md).
// Only names travel, never what was typed.

import { CALL_REQUEST_FIELDS, type CallRequestErrors } from "./call-request";

export const CALL_FORM_TRACKED_FIELDS = [...CALL_REQUEST_FIELDS, "newsletter"] as const;

export type CallFormTrackedField = (typeof CALL_FORM_TRACKED_FIELDS)[number];

/** The tracked field an input's `name` belongs to, or null. */
export function trackedField(name: string): CallFormTrackedField | null {
  return CALL_FORM_TRACKED_FIELDS.find((field) => field === name) ?? null;
}

/** The names of the fields with an error, in form order. */
export function invalidFields(errors: CallRequestErrors): string[] {
  return CALL_REQUEST_FIELDS.filter((field) => errors[field]);
}
