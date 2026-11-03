// Every step name the worker runs, one list (app_docs/status.md). The studio's
// step words (apps/studio/src/lib/step-words.ts) read this file as text and
// give each name its plain words, so keep one name per line, double quoted.
export const STEP_NAMES = [
  "check_footage",
  "convert",
  "transcribe",
  "retime",
  "head_track",
  "preview_copies",
  "first_version",
  "decide",
  "cutout",
  "restore",
  "render",
  "describe_photo",
  "photo_images",
] as const;
