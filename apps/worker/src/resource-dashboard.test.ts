import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STEP_NAMES } from "./step-names.ts";

// The "Worker resources" dashboard of the local monitoring stack
// (app_docs/measurement.md, Resource metrics) names things the worker and the
// compose files own. These checks keep the two sides together.
function repoFile(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of this repository
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

interface Panel {
  type: string;
  title: string;
  datasource?: { uid: string };
  targets?: { expr?: string; query?: string; interval?: string; datasource: { uid: string } }[];
  fieldConfig?: { defaults: { mappings?: { options: Record<string, unknown> }[] } };
}

const DASHBOARD = JSON.parse(repoFile("monitoring/grafana/dashboards/worker-resources.json")) as {
  uid: string;
  panels: Panel[];
  templating: { list: { name: string; query: string }[] };
};
const TEXT = JSON.stringify(DASHBOARD);
const variable = (name: string) => DASHBOARD.templating.list.find((v) => v.name === name)?.query;

describe("worker resources dashboard", () => {
  it("keeps the uid the docs and yarn dev:studio link to", () => {
    expect(DASHBOARD.uid).toBe("worker-resources");
    expect(repoFile("scripts/dev-studio.sh")).toContain("/d/worker-resources");
  });

  it("reads the worker container compose.yaml starts and the local Supabase database", () => {
    const compose = repoFile("compose.yaml");
    expect(compose).toContain("\nname: edit-issebya-worker\n");
    expect(compose).toMatch(/\nservices:\n {2}worker:\n/);
    // Compose names a container <project>-<service>-<number>.
    expect(variable("worker")).toBe("edit-issebya-worker-worker-1");
    // The Supabase CLI names the database container supabase_db_<project_id>.
    expect(repoFile("supabase/config.toml")).toMatch(/^project_id = "edit-issebya"$/m);
    expect(variable("db")).toBe("supabase_db_edit-issebya");
  });

  it("queries only the two data sources the image provisions, metrics at the scrape interval", () => {
    const targets = DASHBOARD.panels.flatMap((panel) => panel.targets ?? []);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(["prometheus", "tempo"]).toContain(target.datasource.uid);
      // Without its own interval a rate would use the data source's 60 seconds.
      if (target.expr) expect(target.interval).toBe("10s");
    }
    expect(repoFile("monitoring/prometheus.yaml")).toContain("scrape_interval: 10s");
  });

  it("gives every step name a colour on the steps timeline", () => {
    const timeline = DASHBOARD.panels.find((panel) => panel.type === "state-timeline");
    const coloured = Object.keys(timeline?.fieldConfig?.defaults.mappings?.[0]?.options ?? {});
    expect(coloured.sort()).toEqual(STEP_NAMES.map((name) => `step ${name}`).sort());
  });

  it("reads the span attributes the worker writes", () => {
    for (const attribute of [
      "span.step.wall_ms",
      "span.step.cpu_ms",
      "span.step.peak_rss_bytes",
      "span.step.bytes_in",
      "span.step.bytes_out",
      "span.job.queue_wait_ms",
      "span.r2.operation",
      "span.r2.kind",
      "span.r2.bytes",
      "span.r2.outcome",
    ]) {
      expect(TEXT).toContain(attribute);
    }
  });

  it("has no em-dash and no machine path", () => {
    expect(TEXT).not.toContain("—");
    expect(TEXT).not.toContain("/Users/");
  });
});
