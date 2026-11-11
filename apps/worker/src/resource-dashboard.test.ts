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

interface Target {
  expr?: string;
  query?: string;
  queryType?: string;
  interval?: string;
  datasource: { type: string; uid: string };
  // The Infinity data source's fields.
  type?: string;
  source?: string;
  parser?: string;
  url?: string;
  root_selector?: string;
}

interface Panel {
  type: string;
  title: string;
  datasource?: { uid: string };
  targets?: Target[];
  transformations?: { id: string; options: { fields?: string[] } }[];
  fieldConfig?: {
    defaults: { mappings?: { options: Record<string, { color?: string }> }[] };
  };
}

// The plugin and the data source that read a reel's whole trace as JSON.
const INFINITY = "yesoreyeram-infinity-datasource";
const TRACE_JSON = "tempo-trace-json";
// The four panels built from the reel's whole trace.
const TIMELINE = "Steps on the metrics' time axis";
const TRACE_TABLES = [
  "Per step: time, cores, memory, bytes",
  "Jobs: queue wait and run time",
  "R2 reads and writes",
];

const DASHBOARD = JSON.parse(repoFile("monitoring/grafana/dashboards/worker-resources.json")) as {
  uid: string;
  panels: Panel[];
  templating: { list: { name: string; query: string }[] };
};
const TEXT = JSON.stringify(DASHBOARD);
const variable = (name: string) => DASHBOARD.templating.list.find((v) => v.name === name)?.query;
const panel = (title: string) => DASHBOARD.panels.find((p) => p.title === title);

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

  it("queries only provisioned data sources, metrics at the scrape interval", () => {
    const targets = DASHBOARD.panels.flatMap((p) => p.targets ?? []);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      // prometheus and tempo come with the image, the third from monitoring/grafana/datasources.yaml.
      expect(["prometheus", "tempo", TRACE_JSON]).toContain(target.datasource.uid);
      // Without its own interval a rate would use the data source's 60 seconds.
      if (target.expr) expect(target.interval).toBe("10s");
    }
    expect(repoFile("monitoring/prometheus.yaml")).toContain("scrape_interval: 10s");
  });

  it("installs the Infinity plugin at a pinned version, in the background", () => {
    const compose = repoFile("docker-compose.monitoring.yml");
    // A version, never latest and never a bare plugin id.
    expect(compose).toMatch(
      /\n {6}GF_PLUGINS_PREINSTALL: yesoreyeram-infinity-datasource@\d+\.\d+\.\d+\n/,
    );
    // The synchronous setting stops Grafana, and the container, when the download fails.
    expect(compose).not.toMatch(/^\s*GF_PLUGINS_PREINSTALL_SYNC:/m);
    expect(compose).not.toMatch(/^\s*GF_INSTALL_PLUGINS:/m);
  });

  it("provisions the trace JSON data source on Tempo's port inside the container", () => {
    const compose = repoFile("docker-compose.monitoring.yml");
    expect(compose).toContain(
      "./monitoring/grafana/datasources.yaml:/otel-lgtm/grafana/conf/provisioning/datasources/edit-issebya.yaml:ro",
    );
    const source = repoFile("monitoring/grafana/datasources.yaml");
    expect(source).toContain(`type: ${INFINITY}`);
    expect(source).toContain(`uid: ${TRACE_JSON}`);
    expect(source).toMatch(/^ {4}url: http:\/\/127\.0\.0\.1:3200$/m);
    expect(source).toMatch(/allowedHosts:\n {8}- http:\/\/127\.0\.0\.1:3200\n/);
  });

  it("reads the timeline and the three tables from the whole trace by id, never a search", () => {
    // A TraceQL search returns only some of a multi-block trace's spans (app_docs/measurement.md, Notes).
    for (const title of [TIMELINE, ...TRACE_TABLES]) {
      const targets = panel(title)?.targets ?? [];
      expect(targets, title).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        datasource: { type: INFINITY, uid: TRACE_JSON },
        type: "json",
        source: "url",
        parser: "backend",
        url: "/api/traces/${reel}",
      });
    }
    // The only Tempo query left is the trace view's, and it names the trace, with no search.
    const tempo = DASHBOARD.panels
      .flatMap((p) => p.targets ?? [])
      .filter((t) => t.datasource.uid === "tempo");
    expect(tempo.map((t) => t.query)).toEqual(["$reel"]);
  });

  it("gives every step name a colour on the steps timeline", () => {
    const options = panel(TIMELINE)?.fieldConfig?.defaults.mappings?.[0]?.options ?? {};
    const coloured = Object.keys(options).filter((state) => state !== "idle");
    expect(coloured.sort()).toEqual(STEP_NAMES.map((name) => `step ${name}`).sort());
  });

  it("ends each step's bar where the step ends, one timeline row per step name", () => {
    const timeline = panel(TIMELINE);
    expect(timeline?.type).toBe("state-timeline");
    const selector = timeline?.targets?.[0]?.root_selector ?? "";
    // One row at the start with the step's name, one at the end with an explicit idle state: a
    // null there leaves the bar running until the next step starts.
    expect(selector).toContain(
      '"time": $ms($s.startTimeUnixNano), "step": $s.name, "state": $s.name',
    );
    expect(selector).toContain('"time": $ms($s.endTimeUnixNano), "step": $s.name, "state": "idle"');
    expect(timeline?.fieldConfig?.defaults.mappings?.[0]?.options.idle?.color).toBe("transparent");
    // A row per step name, so a step inside another (cutout inside decide) is not hidden.
    const split = timeline?.transformations?.find((t) => t.id === "partitionByValues");
    expect(split?.options.fields).toEqual(["step"]);
  });

  it("reads the span attributes the worker writes", () => {
    const read: Record<string, string[]> = {
      "Per step: time, cores, memory, bytes": [
        "step.wall_ms",
        "step.cpu_ms",
        "step.peak_rss_bytes",
        "step.bytes_in",
        "step.bytes_out",
        "step.cache_hit",
      ],
      "Jobs: queue wait and run time": ["job.queue_wait_ms", "job.outcome", "job.attempt"],
      "R2 reads and writes": [
        "r2.operation",
        "r2.kind",
        "r2.cache_step",
        "r2.bytes",
        "r2.outcome",
        "r2.multipart_parts",
      ],
    };
    expect(Object.keys(read)).toEqual(TRACE_TABLES);
    for (const [title, attributes] of Object.entries(read)) {
      const selector = panel(title)?.targets?.[0]?.root_selector ?? "";
      for (const attribute of attributes) expect(selector, title).toContain(`"${attribute}"`);
    }
  });

  it("has no em-dash and no machine path", () => {
    expect(TEXT).not.toContain("—");
    expect(TEXT).not.toContain("/Users/");
  });
});
