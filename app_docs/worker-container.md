# Worker in a container on the Mac: bridges, shims and the same-path scratch

**Specifications:**

- None: a runtime change for the owner's Mac (see the Notes).

## Overview

The worker (`apps/worker`) runs in a Docker container on the owner's Mac (Docker Desktop). Only the
worker is containerized. Claude Code and the cut-out mask tool (`vseg`) stay native on macOS, each
behind a small HTTP bridge, because Claude Code needs the owner's login and `vseg` needs Apple
Vision. Web, studio, Supabase and the otel-lgtm monitoring stay as they are.

The worker code is unchanged: its step runner, `/usr/bin/time` wrapper and AI parsing run exactly as
on the Mac. Two shims inside the container stand in for the two programs, and forward each call to
the bridge that runs the real program on the Mac.

## How it works

Where each piece runs:

| piece                      | where                                 | how the worker reaches it                                                          |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| worker (`src/main.ts`)     | container                             | `docker compose up`                                                                |
| Claude Code                | Mac, claude bridge on 127.0.0.1:8791  | `CLAUDE_CODE_PATH` = `apps/worker/bin/claude-bridge.ts` (shim)                     |
| cut-out (`vseg`)           | Mac, cut-out bridge on 127.0.0.1:8792 | `VSEG_BRIDGE_URL` set, `maskToolCall` runs `apps/worker/bin/vseg-bridge.ts` (shim) |
| Supabase (local)           | Mac, 54431                            | `SUPABASE_URL=http://host.docker.internal:54431` (compose)                         |
| OTLP (otel-lgtm, optional) | Mac, 4318                             | `OTEL_EXPORTER_OTLP_ENDPOINT` from `WORKER_DOCKER_OTLP_ENDPOINT` (compose)         |
| R2, PostHog                | internet                              | from the env file, unchanged                                                       |

- `apps/worker/src/bridge/protocol.ts`: the wire format and the fixed ports (`CLAUDE_BRIDGE_PORT`
  8791, `CUTOUT_BRIDGE_PORT` 8792, bound to `BRIDGE_HOST` 127.0.0.1). A call is one
  `POST /run` with JSON `{argv, cwd, stdin}` and the header `x-bridge-token`; the answer is NDJSON
  frames of base64 stdout or stderr chunks, then the exit code or signal. `GET /health` needs no token.
- `apps/worker/src/bridge/server.ts`: the generic bridge. It runs its one program (fixed at start,
  never a command the caller names), refuses a bad token (401), a folder outside the scratch folder
  (400) and arguments its policy does not allow (400), and kills the program when the caller goes
  away (SIGTERM, then SIGKILL), so a cancelled step leaves nothing running.
- `apps/worker/src/bridge/policy.ts`: what each bridge runs. The claude bridge accepts `-p` and the
  flags `ai.ts` sends (`--output-format json`, `--json-schema` an object, `--tools ""` or `Read`,
  `--allowedTools Read(<file>)`, `--permission-prompts none`, `--model`, `--no-session-persistence`);
  any other flag is refused, so a token holder cannot widen tools or folders. The cut-out bridge
  accepts exactly the shape `maskToolArgs` writes, with the input and output inside the scratch
  folder. Tests tie the claude policy to the arguments `aiRunner` really builds.
- `apps/worker/src/bridge/client.ts` and `shim.ts`: the shim forwards argv, the folder and stdin (the
  claude shim only; vseg reads none), writes the bridge's stdout and stderr to its own, and ends with
  the same exit code, or re-raises the same signal. A bridge that cannot be reached exits 1 with one
  line naming the URL.
- `apps/worker/src/cutout/mask-tool.ts`: with `VSEG_BRIDGE_URL` set (and only then), `maskToolCall`
  returns the vseg shim and skips the darwin and built-binary checks, which the bridge makes.
  `E2E_MOCK_MASK` still wins first.
- `apps/worker/src/doctor.ts` and `doctor-checks.ts`: with a bridge URL set, the doctor adds
  `claude bridge` and `cut-out bridge` lines (their `/health`), skips the local build, and runs the
  mask check on a copy of the sample inside the scratch folder. Its temp folders are in the scratch
  folder, never in the container's `/tmp`, because the Mac must see every path a bridge receives.

### The same-path scratch folder

Paths pass through the bridges unchanged, so a file the worker writes in its scratch folder must
have the same absolute path on the Mac. The compose file bind-mounts `WORKER_SCRATCH_DIR` at that
same path inside the container. Set `WORKER_SCRATCH_DIR` in the shell (or in the command) to the
folder the native worker uses; the value is the one in `apps/worker/.env.development`. The two
bridges read the same variable (from the same env file, or the shell), and they refuse any folder
outside it. The folder must be under a path Docker Desktop shares (by default `/Users`, `/Volumes`,
`/private`, `/tmp`, `/var/folders`).

Everything the claude call reads or writes (its folder, the photo copy of `describe_photo`, the
footage of the cut-out) is under the job's scratch folder, so the same-path mount covers it.

### host.docker.internal and the bind address

Docker Desktop on the Mac resolves `host.docker.internal` to the host. A host service bound to
127.0.0.1 is reachable from a container through it: checked with a node server on 127.0.0.1 and
`docker run node:24-trixie-slim` fetching `http://host.docker.internal:<port>`, which answered. So the
bridges bind 127.0.0.1 only, and nothing listens on the LAN. The token is still required.

### Image

`apps/worker/Dockerfile` (built from the repository root; `.dockerignore` keeps secrets, the
dependencies and the apps the worker does not run out of the context):

- `node:24-trixie-slim` (Debian 13, arm64 or amd64 by the platform).
- ffmpeg 7.1 from Debian (the doctor needs 7 or newer), `procps` (the process-tree memory sample
  uses `ps`), `time` (`/usr/bin/time -v`, the Linux branch of `timeCommand`), Chromium (HyperFrames
  renders with it through `PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium`), fontconfig and fonts.
- `whisper-cli`, built from the pinned whisper.cpp tag `v1.9.5` with the libraries linked in, at
  `HYPERFRAMES_WHISPER_PATH`. The `small` model (`ggml-small.bin`, HyperFrames' pinned revision and
  sha256) is in the image at `/home/node/.cache/hyperframes/whisper/models`, so the first transcribe
  does not download it.
- Yarn 4 through corepack, `yarn workspaces focus @edit-issebya/worker` (with `LEFTHOOK=0`), then the
  worker's source. Runs as `node`, with `CMD node src/main.ts`.

### Compose

- `compose.yaml` (development, the default): the `worker` service with `env_file` =
  `apps/worker/.env.development`; the environment overrides only what must differ inside the
  container (the scratch path, the shims, the bridge URLs, `FFMPEG_PATH` (the env file's is the
  Mac's), `SUPABASE_URL` and `WORKER_STATE_DIR`, and `OTEL_EXPORTER_OTLP_ENDPOINT` from
  `WORKER_DOCKER_OTLP_ENDPOINT`, empty by default so no export is attempted). It mounts the three
  packages' `src` read-only so an edit needs no rebuild. The host-gateway entry makes
  `host.docker.internal` resolve on Linux hosts too.
- `compose.prod.yaml` (production override, `docker compose -f compose.yaml -f compose.prod.yaml`):
  `env_file` = `apps/worker/.env.production`, the environment and the mounts are reset to what
  production needs (the scratch folder, the shims and the bridge URLs, `FFMPEG_PATH`), and no source
  is mounted. The same image.

## How to Run

One command, from the repository root: `yarn dev:studio` (`scripts/dev-studio.sh`). Nothing to
remember, no flags. In order, it:

1. Checks Docker, the local Supabase stack, the migrations and the three env files.
2. Builds the cut-out tool (`build:vseg`) when `tools/vseg/.build/vseg` is missing or older than
   `vseg.swift`.
3. Cleans up a run that did not stop cleanly: `docker compose down` for the worker and any old bridge
   still holding port 8791 or 8792 (it refuses to touch anything else on those ports).
4. Starts both bridges and waits for their `/health`.
5. Builds the worker image and runs the doctor inside it (`docker compose run --rm worker node src/doctor.ts`).
6. Starts local monitoring, web, studio and the worker container (`docker compose up`).

Ctrl-C, a kill, or closing the terminal stops web, studio, the bridges and the worker container (the
script ends with `docker compose down`). Monitoring keeps running; stop it with
`docker compose -f docker-compose.monitoring.yml down`.

The script sets the scratch folder itself: `WORKER_SCRATCH_DIR=$HOME/.edit-issebya-worker/scratch`,
exported to the bridges and to compose (it wins over the env file's line), so both sides always
agree. `apps/worker/.env.development` must hold `BRIDGE_TOKEN` (a long random string; never commit it).

By hand (debugging only): `yarn workspace @edit-issebya/worker bridge:claude`, `... bridge:cutout`,
then `WORKER_SCRATCH_DIR=<folder> docker compose up --build`. Production adds `-f compose.prod.yaml`.

### Keep-awake

Each native bridge runs `caffeinate -i -w <its pid>` for its whole life on macOS
(`startKeepAwake` in `apps/worker/src/keep-awake.ts`, started by `serveBridge`), so the Mac stays awake
while any bridge runs. A sleeping Mac freezes Docker and every job in it. The container never spawns
it (Linux). Stopping a bridge (Ctrl-C) stops its caffeinate.

### Resources

Give Docker Desktop 4 to 6 CPUs and at least 6 GB of memory (Settings, Resources). Renders and
transcribes are the heavy steps; below that they swap or slow down. These numbers are the
recommendation, not a measurement on this Mac.

## Rules

- Never bind a bridge to anything but 127.0.0.1 without a token, and never run one without
  `BRIDGE_TOKEN`; a bridge without the token refuses to start.
- Never let a bridge run a program other than its one fixed binary, or a flag or value its policy does
  not list (`policy.ts`); widening the claude policy is an owner decision, made with the Claude Code
  rules in `app_docs/decide-step.md`.
- Never give a bridge a folder outside `WORKER_SCRATCH_DIR`, and never mount the scratch folder at a
  different path than the Mac's.
- Never put `CLAUDE_BRIDGE_URL`, `VSEG_BRIDGE_URL` or `CLAUDE_CODE_PATH` (for the shims) in an env file:
  they belong to compose, so the native worker keeps using the Mac's own tools.
- Never run the container with the bridges' keep-awake assumed: the container does not keep the Mac
  awake; a bridge must be running.
- Never call the doctor's mask check in the container without `VSEG_BRIDGE_URL` set: it would look for
  a macOS build in the container.

## Testing

- `yarn workspace @edit-issebya/worker test` (pure): `bridge/policy.test.ts` (the claude argv from
  `aiRunner` is accepted; the refusals), `bridge/server.test.ts` (token, paths, streaming, stdin,
  refusals, a program that cannot start, a caller that leaves kills the program),
  `bridge/shim.test.ts` (the shim as a child process: stdout, stderr, exit, stdin, signal, missing
  variables, an unreachable bridge), `keep-awake.test.ts` (`startKeepAwake`), `cutout/mask-tool.test.ts`
  (the shim route), `doctor-checks.test.ts` (the bridge lines and the work folder), and
  `time-report.test.ts` (the GNU report branch).
- Manual (the owner's Mac, Docker Desktop): build the image, start both bridges, run the doctor in the
  container. The result of the last run is in the Notes.

## Notes

- Verified in this session: `docker compose build` of `apps/worker/Dockerfile`; in the image
  `whisper-cli --help`, `chromium --version` (156), `ffmpeg -version` (7.1.5), `/usr/bin/time -v`, `ps`;
  `docker compose ... config --no-env-resolution` for both files; the container doctor run, all 14
  lines `ok` and exit 0 (Supabase and R2 reached through `host.docker.internal` and the env file;
  both bridges' health; `ai structured call`, `ai summary call` (claude-haiku-5-5), `ai image call`
  through the claude shim; `mask tool through the cut-out bridge, 1 s masked in 2.6 s`; the scratch
  folder). The GNU time report parses in the image (`parseTimeReport("linux")`, see the Notes).
- Not verified here: a real HyperFrames render or transcribe inside the container (the doctor runs
  `hyperframes --version` only); a real export through the bridges end to end. Chromium is Debian's,
  not the managed `chrome-headless-shell`, so HyperFrames logs its system-Chrome warning and falls
  back to screenshot capture (slower, same output).
- The dev error log (`WORKER_STATE_DIR`) lives in the container at `/home/node/.edit-issebya-worker/dev`,
  mounted from `~/.edit-issebya-worker`, so `yarn dev:studio errors` reads the container's failures too.
- Cloud is out of scope: a job from a cloud host needs the bridges reachable from there, or the two
  programs folded into Docker later (the bridges were built to move into containers one at a time).
- The doctor's temp folders are created in the scratch folder and removed after the checks.
