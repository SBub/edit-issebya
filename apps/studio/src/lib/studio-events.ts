// Every studio event; names are never renamed once shipped. All are sent:
// studio_footage_uploaded, studio_preview_opened, studio_change_requested
// (reel_id only, never the request text), studio_export_requested and
// studio_export_downloaded (ExportPanel, reel_id only). Dependency-free, so the
// PostHog dashboard script (scripts/posthog-dashboard/) imports the names
// without loading posthog-js.
export const STUDIO_EVENTS = [
  "studio_footage_uploaded",
  "studio_preview_opened",
  "studio_change_requested",
  "studio_export_requested",
  "studio_export_downloaded",
] as const;
// The owner's actions on the reel page's overlay, kept out of STUDIO_EVENTS
// because the dashboard's funnel uses that list as its series:
// studio_failure_action (reel_id, job_id of the failed job, action,
// failure_kind, step, job_kind). Never renamed once shipped.
export const STUDIO_ACTION_EVENTS = ["studio_failure_action"] as const;
export type StudioEvent = (typeof STUDIO_EVENTS)[number] | (typeof STUDIO_ACTION_EVENTS)[number];
