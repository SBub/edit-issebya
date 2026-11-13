import { selectOwnerItems } from "./owner-marks.ts";
import type { CuratorSources, ParseCurrent } from "./curator-input.ts";
import type { Dataset, EvalsApi } from "./posthog-evals.ts";
import { type SnapshotPlan, planSnapshot, snapshotBody } from "./snapshot.ts";
import type { Preset } from "@edit-issebya/edit";

// THE REFRESH STEP (app_docs/evals.md, "What happens automatically"): every eval
// command runs it before the eval reads the dataset. For each labelled reel it
// reads the app's data (the only eval code that does: the sources are injected,
// wired by `src/eval.ts`), compares it with the item's snapshot, and writes a
// new item version for each reel whose snapshot is missing or stale. The eval
// then reads the dataset this step leaves.

export interface RefreshOptions {
  datasetId: string;
  // Prints what would be refreshed; the dataset returned holds the refreshed items in memory.
  dryRun: boolean;
  // Only the labelled reel whose id starts like this.
  reel?: string;
  // Writes every selected reel's snapshot, stale or not (`eval snapshot`).
  force?: boolean;
}

export interface RefreshDeps {
  posthog: Pick<EvalsApi, "dataset" | "updateItem">;
  sources: CuratorSources;
  preset?: Preset;
  parseCurrent?: ParseCurrent;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RefreshResult {
  // The dataset the evals read: re-read after the writes, or with the refreshed items in memory on a dry run.
  dataset: Dataset;
  // The reels refreshed (on a dry run, the reels that would be).
  refreshed: string[];
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// JSON with sorted keys: PostHog stores JSON as jsonb, which does not keep key order.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Why an item's snapshot must be written again, or none. Stale: the item has no
// snapshot; a version or curator run the reel has now is not in the recorded
// source version ids; or the curator input read now differs from the stored one.
export function staleReasons(plan: SnapshotPlan): string[] {
  const raw = plan.item.raw;
  const metadata = objectOf(objectOf(raw).metadata);
  const input = objectOf(objectOf(raw).input);
  if (typeof metadata.snapshot_at !== "string" || input.curator_input === undefined) {
    return ["no snapshot yet"];
  }
  const recorded = Array.isArray(metadata.snapshot_source_version_ids)
    ? metadata.snapshot_source_version_ids.map(String).sort()
    : [];
  const reasons: string[] = [];
  if (!sameList(recorded, plan.versionIds)) reasons.push("a new version or curator run");
  if (canonical(input.curator_input) !== canonical(plan.curator)) {
    reasons.push("the curator input changed");
  }
  return reasons;
}

// What a snapshot holds, for the log line of a forced refresh.
function planDetail(plan: SnapshotPlan): string {
  const picks = plan.runs.reduce((total, run) => total + run.picks.length, 0);
  const curator =
    plan.curator.status === "ready"
      ? `curator input ready from version ${plan.curator.version_number}, hook from ${plan.curator.hook.source}`
      : `curator input skipped: ${plan.curator.reason}`;
  return `${plan.runs.length} curator runs (${picks} picks), ${plan.differing} runs of this reel left out (another transcript), ${curator}`;
}

// The dataset with the given items' snapshot fields replaced, in memory only.
function withSnapshots(
  dataset: Dataset,
  updates: Map<string, { input: unknown; metadata: Record<string, unknown> }>,
): Dataset {
  const items = dataset.items.map((raw) => {
    const id = String(objectOf(raw).id);
    const update = updates.get(id);
    return update ? { ...(raw as object), input: update.input, metadata: update.metadata } : raw;
  });
  return { ...dataset, items };
}

export async function refreshDataset(
  options: RefreshOptions,
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const dataset = await deps.posthog.dataset(options.datasetId);
  const items = selectOwnerItems(dataset.items, options.reel);
  const plans = await planSnapshot(items, deps.sources, {
    ...(deps.preset ? { preset: deps.preset } : {}),
    ...(deps.parseCurrent ? { parseCurrent: deps.parseCurrent } : {}),
  });
  const due = plans.flatMap((plan) => {
    const reasons = options.force ? ["forced"] : staleReasons(plan);
    return reasons.length > 0 ? [{ plan, reasons }] : [];
  });
  if (due.length === 0) {
    log(`snapshot: all ${plans.length} labelled reels are up to date`);
    return { dataset, refreshed: [] };
  }
  const line = (verb: string, plan: SnapshotPlan, reasons: string[]) =>
    `${verb} reel ${plan.item.reelId}: ${reasons.join(", ")}${options.force ? `; ${planDetail(plan)}` : ""}`;

  const snapshotAt = now().toISOString();
  if (options.dryRun) {
    for (const { plan, reasons } of due) log(line("would refresh", plan, reasons));
    const updates = new Map(
      due.map(({ plan }) => {
        const body = snapshotBody(plan, snapshotAt);
        return [plan.item.id, { input: body.input, metadata: body.metadata }] as const;
      }),
    );
    return {
      dataset: withSnapshots(dataset, updates),
      refreshed: due.map(({ plan }) => plan.item.reelId),
    };
  }

  let written = 0;
  for (const { plan, reasons } of due) {
    try {
      await deps.posthog.updateItem(plan.item.id, snapshotBody(plan, snapshotAt));
    } catch (error) {
      // Each update is a new version, so the next eval run refreshes the rest.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; stopped after ${written} of ${due.length} reels, run the eval again to finish`,
      );
    }
    written += 1;
    log(line("refreshed", plan, reasons));
  }
  return {
    dataset: await deps.posthog.dataset(options.datasetId),
    refreshed: due.map(({ plan }) => plan.item.reelId),
  };
}

// The PostHog client an eval runs with: the same client, whose dataset is the
// one the refresh step left. Every eval command goes through this.
export async function refreshedPosthog(
  posthog: EvalsApi,
  options: RefreshOptions,
  deps: Omit<RefreshDeps, "posthog">,
): Promise<EvalsApi> {
  const { dataset } = await refreshDataset(options, { ...deps, posthog });
  return { ...posthog, dataset: async () => dataset };
}
