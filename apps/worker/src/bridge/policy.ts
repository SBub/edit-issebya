import { isAbsolute, resolve, sep } from "node:path";

// What each bridge agrees to run. The bridge spawns its one program with these
// arguments and nothing else: a token holder cannot widen Claude Code's tools,
// permissions or folders, nor point vseg at a file outside the scratch folder.

// True when the path is absolute, already normal (no `..`), and inside the folder.
export function insideFolder(path: string, folder: string): boolean {
  const root = resolve(folder);
  return isAbsolute(path) && resolve(path) === path && path.startsWith(`${root}${sep}`);
}

// The model id shape ai.ts checks before it passes `--model`.
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// The one file a describe_photo call may read (ai.ts READ_FILE).
const READ_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// Claude Code's flags with one value, each with the values the worker sends.
const CLAUDE_VALUED = new Map<string, (value: string) => boolean>([
  ["--output-format", (value) => value === "json"],
  ["--json-schema", isJsonObject],
  // No tools at all, or only Read (never Bash, Edit or Write).
  ["--tools", (value) => value === "" || value === "Read"],
  ["--allowedTools", (value) => /^Read\(.+\)$/.test(value) && READ_FILE.test(value.slice(5, -1))],
  ["--permission-prompts", (value) => value === "none"],
  ["--model", (value) => MODEL.test(value)],
]);
const CLAUDE_FLAGS = new Set(["--no-session-persistence"]);

// The claude bridge's argument check: `-p` first, then only the flags above.
export function claudeArgsRefusal(argv: string[]): string | null {
  if (argv[0] !== "-p") return "claude: the first argument must be -p";
  let index = 1;
  while (index < argv.length) {
    const flag = argv[index] ?? "";
    if (CLAUDE_FLAGS.has(flag)) {
      index += 1;
      continue;
    }
    const allowed = CLAUDE_VALUED.get(flag);
    if (!allowed) return `claude: argument ${flag} is not allowed through the bridge`;
    const value = argv[index + 1];
    if (value === undefined || !allowed(value)) {
      return `claude: ${flag} has a value the bridge does not allow`;
    }
    index += 2;
  }
  return null;
}

// Plain seconds: digits, optionally a fraction (maskToolArgs writes three places).
function isSeconds(value: string): boolean {
  const [whole, fraction, ...rest] = value.split(".");
  return (
    rest.length === 0 &&
    /^[0-9]{1,12}$/.test(whole ?? "") &&
    (fraction === undefined || /^[0-9]{1,6}$/.test(fraction))
  );
}

// The cut-out bridge's argument check: exactly the shape maskToolArgs writes,
// with the input and the output inside the scratch folder.
export function cutoutArgsRefusal(argv: string[], scratchDir: string): string | null {
  if (argv.length !== 8) return "cut-out: expected --input, --start, --end and --output";
  const [inputFlag, input, startFlag, start, endFlag, end, outputFlag, output] = argv;
  if (
    inputFlag !== "--input" ||
    startFlag !== "--start" ||
    endFlag !== "--end" ||
    outputFlag !== "--output"
  ) {
    return "cut-out: the arguments are not the mask tool's";
  }
  if (input === undefined || output === undefined) return "cut-out: missing a path";
  if (start === undefined || end === undefined || !isSeconds(start) || !isSeconds(end)) {
    return "cut-out: --start and --end must be seconds";
  }
  if (!insideFolder(input, scratchDir) || !insideFolder(output, scratchDir)) {
    return "cut-out: the input and the output must be inside the scratch folder";
  }
  return null;
}
