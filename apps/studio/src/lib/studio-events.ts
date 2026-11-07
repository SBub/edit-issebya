// Every studio event; names are never renamed once shipped. studio_footage_uploaded,
// studio_preview_opened, studio_export_requested and studio_export_downloaded
// are sent (ExportPanel, reel_id only). studio_change_requested stays listed for
// the dashboard's history but is no longer sent: the change box is removed
// (app_docs/change-requests.md). Dependency-free, so the PostHog dashboard
// script (scripts/posthog-dashboard/) imports the names without loading
// posthog-js.
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
