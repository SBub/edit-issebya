#!/usr/bin/env node
// The Claude Code shim inside the worker container: CLAUDE_CODE_PATH points
// here. It forwards argv, stdin and the folder to the claude bridge on the Mac
// and reproduces its stdout, stderr and exit (src/bridge/shim.ts).
import { runShim } from "../src/bridge/shim.ts";

await runShim({ name: "claude-bridge", urlVar: "CLAUDE_BRIDGE_URL", readsStdin: true });
