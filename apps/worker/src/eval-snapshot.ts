// `yarn workspace @edit-issebya/worker eval:snapshot [--dry-run] [--reel <id>]`: copies
// the app's data the evals need into the PostHog dataset `owner-reels`, once, as
// a new version of each labelled item (app_docs/evals.md, "The snapshot"). The
// only eval code that reads the database and storage (`evals/worker-sources.ts`);
// the judge and curator evals read the dataset items alone.
import { parseArgs } from "node:util";
import { workerConfig } from "./config.ts";
import { posthogEvals } from "./evals/posthog-evals.ts";
import { runSnapshot } from "./evals/snapshot.ts";
import { workerCuratorSources } from "./evals/worker-sources.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";

// The PostHog dataset `owner-reels`: the reels the owner labelled by hand.
const OWNER_REELS_DATASET = "01a1cf52-f6c3-7182-a7d9-5681010286ce";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    reel: { type: "string" },
  },
});

const config = workerConfig();

try {
  await runSnapshot(
    { datasetId: OWNER_REELS_DATASET, dryRun: values["dry-run"], reel: values.reel },
    {
      posthog: posthogEvals(process.env),
      sources: workerCuratorSources(workerSupabase(config), workerStorage(), config.keyPrefix),
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
