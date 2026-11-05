// The cut-out bridge, native on the Mac: runs the one `vseg` binary for the
// worker container. Start with `yarn workspace @edit-issebya/worker bridge:cutout`.
import { existsSync } from "node:fs";
import { VSEG_BINARY } from "../cutout/mask-tool.ts";
import { CUTOUT_BRIDGE_PORT } from "./protocol.ts";
import { cutoutArgsRefusal } from "./policy.ts";
import { refuseToStart, serveBridge } from "./serve.ts";

if (process.platform !== "darwin") {
  refuseToStart(
    `cutout-bridge: the mask tool runs on macOS only (Apple Vision), not ${process.platform}`,
  );
}
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the built tool's fixed path
if (!existsSync(VSEG_BINARY)) {
  refuseToStart(
    "cutout-bridge: mask tool not built, run yarn workspace @edit-issebya/worker build:vseg",
  );
}

serveBridge({
  name: "cutout-bridge",
  port: CUTOUT_BRIDGE_PORT,
  binary: VSEG_BINARY,
  checkArgs: cutoutArgsRefusal,
  // vseg's paths are checked inside the scratch folder; its own folder is
  // irrelevant, so it runs in the scratch folder whatever the caller's folder.
  cwd: "scratch",
});
