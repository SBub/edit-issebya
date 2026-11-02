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
export type StudioEvent = (typeof STUDIO_EVENTS)[number];
