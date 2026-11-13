import { ISSEBYA_PRESET, type Preset } from "@edit-issebya/edit";
import { type CuratorSources, type ParseCurrent, snapshotCuratorInput } from "./curator-input.ts";
import { type CuratorRun, curatorRunsFor, runCandidates } from "./curator-runs.ts";
import type { OwnerItem } from "./owner-marks.ts";
import type { UpdateItemBody } from "./posthog-evals.ts";
import { type StoredCuratorInput, storedRunOf } from "./snapshot-format.ts";

// THE SNAPSHOT (app_docs/evals.md, "The snapshot"): what the eval code reads
// from the app's data for each labelled reel, and the item update that stores
// it. The reads go through injected sources; the DB and R2 adapters are wired
// only by `src/eval.ts`, and the refresh step (`refresh.ts`) is the one caller
// that writes it into the dataset. The judge and curator evals read the items.

export interface SnapshotPlan {
  item: OwnerItem;
  // Every stored curator run decided from this reel's words (re-uploads included).
  runs: CuratorRun[];
  // Runs of the reel itself decided from another transcript (left out).
  differing: number;
  curator: StoredCuratorInput;
  // The versions read: the latest version and each run's version, sorted.
  versionIds: string[];
}

// The reads of every item's snapshot, with no write. The database is read
// once for all the stored runs, then each item is matched by its words.
export async function planSnapshot(
  items: readonly OwnerItem[],
  sources: CuratorSources,
  { preset = ISSEBYA_PRESET, parseCurrent }: { preset?: Preset; parseCurrent?: ParseCurrent } = {},
): Promise<SnapshotPlan[]> {
  const candidates = await runCandidates(sources);
  const plans: SnapshotPlan[] = [];
  for (const item of items) {
    const found = await curatorRunsFor(item, candidates, sources.readJson);
    const curator = await snapshotCuratorInput({
      item,
      candidates,
      sources,
      preset,
      ...(parseCurrent ? { parseCurrent } : {}),
    });
    const versionIds = [
      ...new Set([
        ...found.runs.map((run) => run.versionId),
        ...(curator.status === "ready" ? [curator.version_id] : []),
      ]),
    ].sort();
    plans.push({ item, runs: found.runs, differing: found.differing, curator, versionIds });
  }
  return plans;
}

// The item update for one plan: the new `input` and `metadata` (everything
// already there is kept, the snapshot's fields are added or replaced), the
// expected output as it was, and the version the update is based on (PostHog
// refuses a stale write).
export function snapshotBody(plan: SnapshotPlan, snapshotAt: string): UpdateItemBody {
  const raw = plan.item.raw as {
    id: string;
    version?: unknown;
    input?: Record<string, unknown>;
    expected_output?: unknown;
    metadata?: Record<string, unknown>;
  };
  if (typeof raw.version !== "number") {
    throw new Error(
      `evals: dataset item ${plan.item.id} does not serve its version, so it cannot be updated`,
    );
  }
  return {
    base_version: raw.version,
    input: { ...(raw.input ?? {}), curator_input: plan.curator },
    ...(raw.expected_output !== undefined ? { expected_output: raw.expected_output } : {}),
    metadata: {
      ...(raw.metadata ?? {}),
      past_curator_runs: plan.runs.map(storedRunOf),
      snapshot_at: snapshotAt,
      snapshot_source_version_ids: plan.versionIds,
      snapshot_differing_runs: plan.differing,
    },
  };
}
