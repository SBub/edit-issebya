import { ISSEBYA_PRESET, type Preset } from "@edit-issebya/edit";
import { type CuratorSources, type ParseCurrent, snapshotCuratorInput } from "./curator-input.ts";
import { type CuratorRun, curatorRunsFor, runCandidates } from "./curator-runs.ts";
import { type OwnerItem, selectOwnerItems } from "./owner-marks.ts";
import type { EvalsApi, UpdateItemBody } from "./posthog-evals.ts";
import { type StoredCuratorInput, storedRunOf } from "./snapshot-format.ts";

// THE SNAPSHOT (app_docs/evals.md, "The snapshot"): the one place the eval code
// reads the app's data. For each labelled reel of the dataset it reads the
// curator's past runs and the reel's curator input from the database and
// storage, then writes both into the item as a new item version. The judge and
// curator evals read only the item afterwards. The sources are injected here;
// the DB and R2 adapters are wired only by `src/eval-snapshot.ts`.

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

export interface SnapshotOptions {
  datasetId: string;
  // Prints what would be written; no update is sent.
  dryRun: boolean;
  // Only the labelled reel whose id starts like this.
  reel?: string;
}

export interface SnapshotDeps {
  posthog: Pick<EvalsApi, "dataset" | "updateItem">;
  sources: CuratorSources;
  preset?: Preset;
  parseCurrent?: ParseCurrent;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface SnapshotSummary {
  plans: SnapshotPlan[];
  // Items updated: 0 on a dry run.
  written: number;
}

function planLine(plan: SnapshotPlan): string {
  const picks = plan.runs.reduce((total, run) => total + run.picks.length, 0);
  const curator =
    plan.curator.status === "ready"
      ? `curator input ready from version ${plan.curator.version_number}, hook from ${plan.curator.hook.source}`
      : `curator input skipped: ${plan.curator.reason}`;
  return `reel ${plan.item.reelId}: ${plan.runs.length} curator runs (${picks} picks), ${plan.differing} runs of this reel left out (another transcript), ${curator}`;
}

export async function runSnapshot(
  options: SnapshotOptions,
  deps: SnapshotDeps,
): Promise<SnapshotSummary> {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const dataset = await deps.posthog.dataset(options.datasetId);
  const items = selectOwnerItems(dataset.items, options.reel);
  log(`dataset revision ${dataset.revision}: ${items.length} labelled reels`);
  const plans = await planSnapshot(items, deps.sources, {
    ...(deps.preset ? { preset: deps.preset } : {}),
    ...(deps.parseCurrent ? { parseCurrent: deps.parseCurrent } : {}),
  });
  for (const plan of plans) log(planLine(plan));
  if (options.dryRun) {
    log(`dry run: ${plans.length} items would get a new version, nothing written`);
    return { plans, written: 0 };
  }

  const snapshotAt = now().toISOString();
  let written = 0;
  for (const plan of plans) {
    try {
      await deps.posthog.updateItem(plan.item.id, snapshotBody(plan, snapshotAt));
    } catch (error) {
      // Each update is a new version, so the command can be run again to finish.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; stopped after ${written} of ${plans.length} items, run the snapshot again to finish`,
      );
    }
    written += 1;
    log(`snapshot written for reel ${plan.item.reelId} (item ${plan.item.id})`);
  }
  log(`snapshot: ${written} items updated at ${snapshotAt}`);
  return { plans, written };
}
