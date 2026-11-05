#!/usr/bin/env node
// The cut-out shim inside the worker container: maskToolCall runs this when
// VSEG_BRIDGE_URL is set. It forwards argv and the folder to the cut-out bridge
// on the Mac and reproduces its stdout, stderr and exit (src/bridge/shim.ts).
import { runShim } from "../src/bridge/shim.ts";

await runShim({ name: "vseg-bridge", urlVar: "VSEG_BRIDGE_URL", readsStdin: false });
