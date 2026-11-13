import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type EvalCommand,
  type EvalHandlers,
  parseEvalCommand,
  runEvalCommand,
} from "./command.ts";

// The eval command's routing (app_docs/evals.md, "How to run"): one entry, its
// options checked before any work, each subcommand handed to its own handler.

describe("parsing the eval command", () => {
  it("shows the help with no command, or with help", () => {
    expect(parseEvalCommand([])).toEqual({ kind: "help" });
    expect(parseEvalCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseEvalCommand(["help"])).toEqual({ kind: "help" });
  });

  it("parses the judge's options under their existing names", () => {
    expect(
      parseEvalCommand(["judge", "--dry-run", "--reel", "9dfd03d8", "--label", "staging"]),
    ).toEqual({ kind: "judge", dryRun: true, reel: "9dfd03d8", label: "staging" });
    expect(parseEvalCommand(["judge", "--prompt-file", "/tmp/draft.txt"])).toEqual({
      kind: "judge",
      dryRun: false,
      promptFile: "/tmp/draft.txt",
    });
  });

  it("parses the curator's options, its repeats defaulting to 1", () => {
    expect(parseEvalCommand(["curator"])).toEqual({ kind: "curator", dryRun: false, repeats: 1 });
    expect(
      parseEvalCommand([
        "curator",
        "--repeats",
        "3",
        "--curator-label",
        "staging",
        "--judge-prompt-file",
        "/tmp/judge.txt",
      ]),
    ).toEqual({
      kind: "curator",
      dryRun: false,
      repeats: 3,
      curatorLabel: "staging",
      judgePromptFile: "/tmp/judge.txt",
    });
  });

  it("parses the snapshot subcommand's options", () => {
    expect(parseEvalCommand(["snapshot", "--dry-run", "--reel", "aaaa"])).toEqual({
      kind: "snapshot",
      dryRun: true,
      reel: "aaaa",
    });
  });

  it("refuses a label and a draft file for the same prompt, judge or curator", () => {
    expect(() => parseEvalCommand(["judge", "--label", "x", "--prompt-file", "/tmp/a"])).toThrow(
      "mutually exclusive",
    );
    expect(() =>
      parseEvalCommand(["curator", "--curator-label", "x", "--curator-prompt-file", "/tmp/a"]),
    ).toThrow("mutually exclusive");
    expect(() =>
      parseEvalCommand(["curator", "--judge-label", "x", "--judge-prompt-file", "/tmp/a"]),
    ).toThrow("mutually exclusive");
  });

  it("refuses a repeats count out of range or not whole", () => {
    for (const bad of ["0", "21", "1.5", "many"]) {
      expect(() => parseEvalCommand(["curator", "--repeats", bad])).toThrow(
        "--repeats must be a whole number from 1 to 20",
      );
    }
  });

  it("refuses an option the subcommand does not take, naming it", () => {
    expect(() => parseEvalCommand(["snapshot", "--repeats", "2"])).toThrow(
      /^evals: Unknown option '--repeats'/,
    );
    expect(() => parseEvalCommand(["judge", "--repeats", "2"])).toThrow(/Unknown option/);
  });

  it("refuses an unknown command, and shows the usage", () => {
    expect(() => parseEvalCommand(["snapshots"])).toThrow(/unknown command snapshots/);
    expect(() => parseEvalCommand(["snapshots"])).toThrow(/usage: .* eval <command>/);
  });

  it("refuses a positional argument", () => {
    expect(() => parseEvalCommand(["judge", "extra"])).toThrow(/evals:/);
  });
});

describe("running the eval command", () => {
  // A handler per subcommand that records the command it was given.
  function recording() {
    const calls: { handler: string; command?: EvalCommand }[] = [];
    const handlers: EvalHandlers = {
      help: () => {
        calls.push({ handler: "help" });
      },
      judge: async (command) => {
        calls.push({ handler: "judge", command });
      },
      curator: async (command) => {
        calls.push({ handler: "curator", command });
      },
      snapshot: async (command) => {
        calls.push({ handler: "snapshot", command });
      },
    };
    return { calls, handlers };
  }

  it("calls only the handler the subcommand names, with its parsed command", async () => {
    const { calls, handlers } = recording();
    await runEvalCommand(["curator", "--repeats", "2"], handlers);
    expect(calls).toEqual([
      { handler: "curator", command: { kind: "curator", dryRun: false, repeats: 2 } },
    ]);
    await runEvalCommand(["snapshot", "--dry-run"], handlers);
    expect(calls.at(-1)).toEqual({
      handler: "snapshot",
      command: { kind: "snapshot", dryRun: true },
    });
  });

  it("routes judge and help to their handlers", async () => {
    const { calls, handlers } = recording();
    await runEvalCommand(["judge", "--reel", "aaaa"], handlers);
    await runEvalCommand([], handlers);
    expect(calls.map((call) => call.handler)).toEqual(["judge", "help"]);
  });

  it("calls no handler for an invalid command", async () => {
    const { calls, handlers } = recording();
    await expect(
      runEvalCommand(["judge", "--label", "x", "--prompt-file", "/tmp/a"], handlers),
    ).rejects.toThrow("mutually exclusive");
    expect(calls).toEqual([]);
  });
});

describe("the worker's scripts", () => {
  it("has one eval entry, and no separate eval scripts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const evalScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith("eval"));
    expect(evalScripts).toEqual(["eval"]);
    expect(pkg.scripts.eval).toContain("src/eval.ts");
  });
});
