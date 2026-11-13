import type { ParseCurrent, CuratorSources } from "../src/evals/curator-input.ts";
import { selectOwnerItems } from "../src/evals/owner-marks.ts";
import { planSnapshot, snapshotBody } from "../src/evals/snapshot.ts";

// Test only: the dataset items as they read after `eval:snapshot` ran over
// `sources`, each item with its new version's input and metadata (what PostHog
// would serve). The snapshot's own code is the one under test, not a copy.

export const SNAPSHOT_AT = "2026-11-12T10:00:00.000Z";

export async function snapshotItems(
  rawItems: readonly unknown[],
  sources: CuratorSources,
  options: { parseCurrent?: ParseCurrent } = {},
): Promise<unknown[]> {
  const plans = await planSnapshot(selectOwnerItems(rawItems), sources, options);
  return plans.map((plan) => {
    const body = snapshotBody(plan, SNAPSHOT_AT);
    return { ...(plan.item.raw as object), input: body.input, metadata: body.metadata };
  });
}
