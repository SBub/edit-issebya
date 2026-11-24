import { describe, expect, it } from "vitest";
import { answerResult, roleAi } from "../../test-support/curator-fixtures.ts";
import { OPTIONS, reply, setup } from "../../test-support/curator-run-setup.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { PromptUnavailable } from "../prompts/source.ts";
import { type CompareDeps, runCuratorCompare } from "./run-compare.ts";

// Production is version 1, the draft label version 2.
const VERSIONS: Record<string, number> = { production: 1, draft: 2 };
const COMPARE = { ...OPTIONS, labels: ["production", "draft"] };

function compareSetup(overrides: Parameters<typeof setup>[0] = {}) {
  const made = setup(overrides);
  const deps: CompareDeps = {
    ...made.deps,
    promptsAt: (label) => {
      const version = VERSIONS[label];
      if (version === undefined) {
        return {
          get: async (name) => {
            throw new PromptUnavailable(
              name,
              label,
              `prompt "${name}" label "${label}" not found`,
              "not-found",
            );
          },
        };
      }
      return fakePromptSource(label, version);
    },
  };
  return { ...made, deps };
}

describe("a comparison", () => {
  it("runs production, then the draft, on the one dataset read, and prints one table", async () => {
    const { deps, posthogCalls, ai, lines, reports } = compareSetup();
    const { runs, reportPath } = await runCuratorCompare({ ...COMPARE, repeats: 2 }, deps);

    expect(posthogCalls.filter((call) => call === "dataset")).toHaveLength(1);
    expect(posthogCalls.filter((call) => call === "create")).toHaveLength(2);
    expect(ai.calls.map((call) => call.role)).toEqual(Array(4).fill("decide"));
    expect(runs.map((run) => run.summary?.prompt.id)).toEqual([
      "reel-components@v1",
      "reel-components@v2",
    ]);

    // The versions of both prompts are named before the first call.
    expect(lines).toContain("prompt production: reel-components@v1");
    expect(lines).toContain("prompt draft: reel-components@v2");
    expect(lines.join("\n")).toContain("dataset revision 6, 2 runs per reel");
    const rows = lines.filter((line) => line.startsWith("reel-components@v"));
    // Each row as its prompt finishes, then both in the closing table.
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain("reel-components@v1 (production)");
    expect(rows[3]).toContain("reel-components@v2 (draft)");
    expect(lines.filter((line) => line.startsWith("Prompt "))).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/judge/i);

    // One report per prompt, then the comparison's.
    expect(reports).toHaveLength(3);
    expect(reports[2]).toContain("Components curator comparison");
    expect(reportPath).toMatch(/curator-compare-/);
  });

  it("stops before any call, telling how to create it, when the label has no version", async () => {
    const { deps, ai, posthogCalls } = compareSetup();
    await expect(
      runCuratorCompare({ ...COMPARE, labels: ["production", "nodraft"] }, deps),
    ).rejects.toThrow(
      'no version of reel-components has the label "nodraft". Create it in PostHog: Prompts > reel-components > open the version to try > add the label "nodraft".',
    );
    expect(ai.calls).toEqual([]);
    expect(posthogCalls).toEqual([]);
  });

  it("does not blame the label when the production prompt itself is missing", async () => {
    const { deps } = compareSetup();
    const gone: CompareDeps = {
      ...deps,
      promptsAt: () => ({
        get: async (name) => {
          throw new PromptUnavailable(name, "production", "not found", "not-found");
        },
      }),
    };
    await expect(runCuratorCompare(COMPARE, gone)).rejects.toThrow(/prompts: reel-components/);
  });

  it("notes when both labels point to the same version", async () => {
    const { deps, lines } = compareSetup();
    const same: CompareDeps = { ...deps, promptsAt: () => fakePromptSource("x", 4) };
    await runCuratorCompare({ ...COMPARE, dryRun: true }, same);
    expect(lines.join("\n")).toContain("are the same version (reel-components@v4)");
  });

  it("shows a failed run in the table: counted, its marks missed, the denominators kept", async () => {
    const okRun = compareSetup();
    await runCuratorCompare({ ...COMPARE, labels: ["production"] }, okRun.deps);
    const okRow = okRun.lines.find((line) => line.startsWith("reel-components@v1"))!;

    const failed = compareSetup({ ai: roleAi(() => answerResult({ accents: "nope" })) });
    const { runs } = await runCuratorCompare({ ...COMPARE, labels: ["production"] }, failed.deps);
    const row = failed.lines.find((line) => line.startsWith("reel-components@v1"))!;
    expect(row).toContain("0/1");
    expect(okRow).toContain("1/1");
    const summary = runs[0]!.summary!;
    // The run answered nothing: precision has no picks to count, recall lost all three marks.
    expect(summary.f1.overall).toEqual({ mean: 0, min: 0, max: 0 });
    expect(summary.runs).toEqual({ ok: 0, total: 1 });
    expect(okRun.sent.upload!.results[0]!.value).toBe(1);
    expect(failed.sent.upload!.results[0]).toMatchObject({ status: "error" });
    expect(failed.sent.upload!.results[0]!.payload.metadata).toMatchObject({
      counts: { picks: 0, good: 0, marks: 3, matched: 0 },
    });
  });

  it("prints a finished prompt's row and the table even when a later prompt fails", async () => {
    let decides = 0;
    const { deps, lines } = compareSetup({
      ai: roleAi(() => {
        decides += 1;
        if (decides > 1) throw new Error("the AI is down");
        return reply();
      }),
    });
    await expect(runCuratorCompare(COMPARE, deps)).rejects.toThrow("the AI is down");
    const rows = lines.filter((line) => line.startsWith("reel-components@v1"));
    // Once as the prompt finished, once in the closing table.
    expect(rows).toHaveLength(2);
  });

  it("makes one prompt's run without a comparison report", async () => {
    const { deps, reports } = compareSetup();
    const { runs, reportPath } = await runCuratorCompare({ ...COMPARE, labels: ["draft"] }, deps);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.summary!.prompt).toEqual({ id: "reel-components@v2", label: "draft" });
    expect(reports).toHaveLength(1);
    expect(reportPath).toBeUndefined();
  });

  it("makes no AI call and no experiment on a dry run, and lists the counts once", async () => {
    const { deps, ai, posthogCalls, lines } = compareSetup();
    const { runs } = await runCuratorCompare({ ...COMPARE, dryRun: true }, deps);
    expect(runs).toHaveLength(1);
    expect(ai.calls).toEqual([]);
    expect(posthogCalls).toEqual(["dataset"]);
    expect(lines.join("\n")).toContain("dry run");
    expect(lines).toContain("prompt draft: reel-components@v2");
  });
});
