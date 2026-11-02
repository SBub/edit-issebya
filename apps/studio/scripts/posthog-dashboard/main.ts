// The studio metrics dashboard in PostHog (app_docs/dashboard.md). Usage:
//   yarn workspace @edit-issebya/studio posthog:dashboard [--dry-run]
//     prints the exact API payloads a first apply sends; needs no variable.
//   POSTHOG_PERSONAL_API_KEY=... POSTHOG_PROJECT_ID=... \
//     yarn workspace @edit-issebya/studio posthog:dashboard --apply
//     creates or updates the insights and the dashboard, idempotently.
// The owner runs --apply by hand from their shell. ADW, CI and tests never do.
import { applyDashboard, readApplyEnv } from "./apply.ts";
import { posthogClient } from "./http.ts";
import { dryRunPayloads } from "./payloads.ts";

const USAGE = "usage: posthog:dashboard [--dry-run | --apply]";

const args = process.argv.slice(2);
const mode = args.length === 0 ? "--dry-run" : args.length === 1 ? args[0] : undefined;

if (mode === "--dry-run") {
  console.log(JSON.stringify(dryRunPayloads(), null, 2));
} else if (mode === "--apply") {
  let env;
  try {
    env = readApplyEnv(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const result = await applyDashboard(posthogClient(env.apiKey), env.projectId);
  console.log(`created: ${result.created.join(", ") || "nothing"}`);
  console.log(`updated: ${result.updated.join(", ") || "nothing"}`);
} else {
  console.error(USAGE);
  process.exit(1);
}
