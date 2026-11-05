// The claude bridge, native on the Mac: runs the one `claude` binary for the
// worker container. Start with `yarn workspace @edit-issebya/worker bridge:claude`.
import { resolveExecutable } from "./binary.ts";
import { CLAUDE_BRIDGE_PORT } from "./protocol.ts";
import { claudeArgsRefusal } from "./policy.ts";
import { refuseToStart, serveBridge } from "./serve.ts";

const requested = process.env.CLAUDE_CODE_PATH?.trim() || "claude";
const binary = resolveExecutable(requested);
if (!binary) refuseToStart(`claude-bridge: ${requested} is not an executable (CLAUDE_CODE_PATH)`);

serveBridge({
  name: "claude-bridge",
  port: CLAUDE_BRIDGE_PORT,
  binary,
  checkArgs: (argv) => claudeArgsRefusal(argv),
});
