import { headTrackSchema, transcriptSchema } from "@edit-issebya/edit";
import { z } from "zod";
import type { CuratorRun } from "./curator-runs.ts";

// THE SNAPSHOT'S FORMAT (app_docs/evals.md, "The snapshot"): what the refresh step
// (`refresh.ts`) copies into each dataset item, and what the judge and curator evals read back.
// Pure: no database, no storage. The evals parse their items through here, and
// the snapshot writes them through here, so the two sides cannot drift apart.

const EVAL_COMMAND = "yarn workspace @edit-issebya/worker eval";

const spanSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

const pickSchema = z.object({
  component: z.enum(["accent", "bigword", "list", "question"]),
  span: spanSchema,
  items: z.array(spanSchema).optional(),
});

// One stored curator run, as the item's `metadata.past_curator_runs` holds it.
const pastRunSchema = z.object({
  reel_id: z.string().min(1),
  version_id: z.string().min(1),
  version_number: z.number().int(),
  prompt_version: z.string(),
  unreadable: z.number().int().nonnegative(),
  transcript: transcriptSchema,
  picks: z.array(pickSchema),
});

// The curator's input for one labelled reel, as `input.curator_input` holds it:
// everything the decide step's components call reads that is not in the
// transcript (the preset's name, the written hook), plus the transcript, the
// head track and the latest edit the answer is placed over. `skipped` is what
// the snapshot could not rebuild, with the reason.
const storedCuratorInputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    reel_id: z.string().min(1),
    version_id: z.string().min(1),
    version_number: z.number().int(),
    preset: z.string().min(1),
    transcript: transcriptSchema,
    head_track: headTrackSchema,
    // The latest version's edit as stored; parsed by the eval (`parseEdit`).
    edit: z.unknown(),
    hook: z.object({
      text: z.string().min(1),
      source: z.enum(["version", "ai record"]),
    }),
    // The latest run's stored values, compared with the rebuilt ones (never used in their place).
    stored_run: z.object({
      intensity: z.string().optional(),
      target_picks: z.number().optional(),
    }),
  }),
  z.object({ status: z.literal("skipped"), reason: z.string().min(1) }),
]);

export type StoredCuratorInput = z.infer<typeof storedCuratorInputSchema>;

// The stored form of a curator run (snake_case, as the item holds it).
export type StoredRun = z.infer<typeof pastRunSchema>;

export function storedRunOf(run: CuratorRun): StoredRun {
  return {
    reel_id: run.reelId,
    version_id: run.versionId,
    version_number: run.number,
    prompt_version: run.promptVersion,
    unreadable: run.unreadable,
    transcript: run.transcript,
    picks: run.picks.map((pick) => ({
      component: pick.component,
      span: pick.span,
      ...(pick.items ? { items: pick.items } : {}),
    })),
  };
}

// The item as the snapshot left it: the stored runs read back into the eval's
// shape. Null when the item has no snapshot (`metadata.past_curator_runs` is
// absent); throws when the field is there but malformed.
export function pastRunsOf(raw: unknown, id: string): CuratorRun[] | null {
  const field = (raw as { metadata?: { past_curator_runs?: unknown } } | null)?.metadata
    ?.past_curator_runs;
  if (field === undefined) return null;
  const parsed = z.array(pastRunSchema).safeParse(field);
  if (!parsed.success) {
    throw new Error(
      `evals: dataset item ${id} has a malformed snapshot (metadata.past_curator_runs): ${parsed.error.issues[0]?.message ?? "invalid"}; run ${EVAL_COMMAND} snapshot again`,
    );
  }
  return parsed.data.map((run) => ({
    reelId: run.reel_id,
    versionId: run.version_id,
    number: run.version_number,
    promptVersion: run.prompt_version,
    unreadable: run.unreadable,
    transcript: run.transcript,
    picks: run.picks,
  }));
}

// The item's stored curator input, or null when the item has none. Throws when
// it is malformed.
export function curatorInputOf(raw: unknown, id: string): StoredCuratorInput | null {
  const field = (raw as { input?: { curator_input?: unknown } } | null)?.input?.curator_input;
  if (field === undefined) return null;
  const parsed = storedCuratorInputSchema.safeParse(field);
  if (!parsed.success) {
    throw new Error(
      `evals: dataset item ${id} has a malformed snapshot (input.curator_input): ${parsed.error.issues[0]?.message ?? "invalid"}; run ${EVAL_COMMAND} snapshot again`,
    );
  }
  return parsed.data;
}

// The error an eval gives for an item with no snapshot. The eval command refreshes
// every snapshot before it reads, so this is reached only if the refresh skipped
// the item: the message names the command that refreshes it.
export function missingSnapshot(id: string, field: string): Error {
  return new Error(
    `evals: dataset item ${id} has no snapshot (${field}): run ${EVAL_COMMAND} snapshot to refresh it`,
  );
}

// The runs of the reel itself that were decided from another transcript and so
// left out of the snapshot (`metadata.snapshot_differing_runs`); 0 when absent.
export function differingRunsOf(raw: unknown): number {
  const field = (raw as { metadata?: { snapshot_differing_runs?: unknown } } | null)?.metadata
    ?.snapshot_differing_runs;
  return typeof field === "number" ? field : 0;
}
