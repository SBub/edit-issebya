# Worker in a container: everything in the image

**Specifications:**

- None: a runtime change for the owner's Mac (see the Notes).

## Overview

The worker (`apps/worker`) runs in a Docker container on the owner's Mac (Docker Desktop). Everything
a job runs is inside the image: ffmpeg, HyperFrames with Chromium and whisper, the word aligner,
the MODNet cut-out (`onnxruntime-node` on the CPU) and the AI calls (OpenRouter over HTTPS, `OPENROUTER_API_KEY` from the
env file). Nothing runs natively on the Mac for the worker; web, studio, Supabase and the otel-lgtm
monitoring stay as they are.

The worker code is unchanged: the container runs the same `src/main.ts`, step runner and
`/usr/bin/time` wrapper (its GNU branch) as any Linux host.

## How it works

Where each piece runs:

| piece                   | where                           | how the worker reaches it                                                  |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| worker (`src/main.ts`)  | container                       | `docker compose up`                                                        |
| cut-out (MODNet)        | container, this Node            | `maskToolCall`, the model at `/repo/apps/worker/models` (committed)        |
| head track (U2Net)      | container, this Node            | `u2netArgs`, the model at `/repo/apps/worker/models` (committed)           |
| word aligner (wav2vec2) | container, this Node            | `alignArgs`, the model at `/repo/apps/worker/models` (fetched at build)    |
| AI calls                | OpenRouter (internet)           | `OPENROUTER_API_KEY` from the env file                                     |
| Supabase (local)        | Mac, 54431                      | `SUPABASE_URL=http://host.docker.internal:54431` (compose)                 |
| OTLP (otel-lgtm)        | Mac, 4318                       | `OTEL_EXPORTER_OTLP_ENDPOINT` from `WORKER_DOCKER_OTLP_ENDPOINT` (compose) |
| R2, PostHog             | internet                        | from the env file, unchanged                                               |
| scratch folder          | container, the `scratch` volume | `WORKER_SCRATCH_DIR=/scratch` (compose)                                    |

### Image

`apps/worker/Dockerfile` (built from the repository root; `.dockerignore` keeps secrets, the
dependencies and the apps the worker does not run out of the context):

- `node:24-trixie-slim` (Debian 13, glibc, arm64 or amd64 by the platform).
- ffmpeg 7.1 from Debian (the doctor needs 7 or newer), `procps` (the process-tree memory sample
  uses `ps`), `time` (`/usr/bin/time -v`, the Linux branch of `timeCommand`), Chromium (HyperFrames
  renders with it through `PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium`), fontconfig and fonts.
- `whisper-cli`, built from the pinned whisper.cpp tag `v1.9.5` with the libraries linked in, at
  `HYPERFRAMES_WHISPER_PATH`. The `small` model (`ggml-small.bin`, HyperFrames' pinned revision and
  sha256) is in the image at `/home/node/.cache/hyperframes/whisper/models`, so the first transcribe
  does not download it.
- The MODNet model (`modnet_int8_13.onnx`), the head track's U2Net model
  (`u2net_int8_static13.onnx`) and their notice, part of the worker's folder
  (`apps/worker/models/`, committed), so `COPY apps/worker` puts them at `/repo/apps/worker/models`:
  no download stage and no model folder of its own (`apps/worker/src/dockerfile.test.ts`). Each
  model's size and SHA-256 are checked before each run (`verifyModel`, `verifyU2netModel`). The
  models are not among the folders compose mounts in development, so a new model needs a rebuild.
- The transcribe step's word aligner model (`wav2vec2-base-960h.onnx`, 378 MB, too large to
  commit): the `aligner` build stage fetches it from Hugging Face at the revision and SHA-256
  pinned in `align-model.ts` (`ALIGN_MODEL_REVISION`; `sha256sum -c` fails the build on any other
  file) and the runtime stage copies it to `/repo/apps/worker/models/`, beside the committed models.
  `.dockerignore` keeps a local copy from `models:fetch` out of the build context. It makes the
  image about 378 MB larger. Its size and SHA-256 are checked before each run (`verifyAlignModel`).
- Yarn 4 through corepack, `yarn workspaces focus @edit-issebya/worker` (with `LEFTHOOK=0`), which
  installs `onnxruntime-node`'s prebuilt Linux binary for the image's platform, then the worker's
  source. Runs as `node`, with `CMD node src/main.ts`.
- `/scratch` exists in the image, owned by `node`, so the empty volume mounted there starts writable.

### Compose

- `compose.yaml` (development, the default): the `worker` service with `env_file` =
  `apps/worker/.env.development` (Supabase key, R2 keys, `OPENROUTER_API_KEY` and the rest). The
  environment overrides only what must differ inside the container: `WORKER_SCRATCH_DIR` (`/scratch`),
  `FFMPEG_PATH` (the env file's is the Mac's), `SUPABASE_URL`, and
  `OTEL_EXPORTER_OTLP_ENDPOINT` from `WORKER_DOCKER_OTLP_ENDPOINT` (empty by default, so no export is
  attempted). Mounts: the named volume `scratch` at `/scratch`, and the three packages' `src` read-only so an
  edit needs no rebuild. The host-gateway entry makes `host.docker.internal` resolve on Linux hosts too.
  `WORKER_ENV` is `development` (its AI events' `environment`).
- `compose.prod.yaml` (production override, `docker compose -f compose.yaml -f compose.prod.yaml`):
  `env_file` = `apps/worker/.env.production`, the environment reset to the scratch folder,
  `FFMPEG_PATH` and `WORKER_ENV=production` (its AI events' `environment`), its own scratch volume (`scratch-prod`), and no source mounted. The same
  image, with the model in it: production needs no model volume and no download.

### The scratch folder

Only the worker reads or writes its scratch folder (one folder per job, so the two jobs of the two
lanes never share one; removed after the job, swept at start-up), so it needs no path shared with the Mac. It is a named Docker volume: faster than a
bind-mounted Mac folder on Docker Desktop, and kept across restarts like the native folder.
`WORKER_MIN_FREE_DISK_GB` is measured on that volume, which is Docker Desktop's disk image, not the
Mac's disk.

Chrome's `TMPDIR` is not on the volume: each HyperFrames call of a render (the composite export
runs up to three, two at a time) gets a short `/tmp/hf-*` folder of its own in the container
(`withChromeTmp`, `app_docs/export.md`), removed after the call. It stays out of
`/scratch` because Chrome's Unix socket path must fit in 107 characters.

## How to Run

One command, from the repository root: `yarn dev:studio` (`scripts/dev-studio.sh`). In order, it:

1. Checks Docker, the local Supabase stack, the migrations and the three env files.
2. Cleans up a run that did not stop cleanly (`docker compose down` for the worker).
3. Builds the worker image and runs the doctor inside it
   (`docker compose run --rm worker node src/doctor.ts`, without `--ai`: no paid call at startup).
4. Keeps the Mac awake for its own life (`caffeinate`), starts local monitoring, web, studio and the
   worker container (`docker compose up`).

Ctrl-C, a kill, or closing the terminal stops web, studio and the worker container (the script ends
with `docker compose down`). Monitoring (Grafana and cAdvisor) keeps running; stop it with
`docker compose -f docker-compose.monitoring.yml down`.

By hand (debugging only): `docker compose up --build` from the repository root; the doctor with
`docker compose run --rm worker node src/doctor.ts` (add `--ai` for the two paid OpenRouter calls).
Production adds `-f compose.prod.yaml`.

### Keep-awake

A sleeping Mac freezes Docker and every job in it. The worker in the container never spawns
`caffeinate` (Linux, `withKeepAwake` does nothing there), so `yarn dev:studio` runs
`caffeinate -i -w <its pid>` for its whole life on macOS, stopped with the script.

### Resources

Give Docker Desktop 4 to 6 CPUs and at least 6 GB of memory (Settings, Resources). Renders,
transcribes and the cut-out are the heavy steps; below that they swap or slow down. These numbers are
the recommendation, not a measurement on this Mac. What a step really uses (CPU against the VM's
cores, memory against the VM's total, disk, network, waiting) is on the "Worker resources" dashboard
of local monitoring: `app_docs/measurement.md`, Resource metrics. `compose.yaml` sets no CPU or
memory limit on the worker, so the VM's size is the only ceiling.

The worker runs two lanes at once (`app_docs/studio.md`, "Worker"): one export and, beside it, one
other job (an upload's processing, a photo, an edit). The two share the VM's CPUs and memory, and
nothing limits their sum. Measured alone on the 7.75 GiB VM, an export's process tree peaks at 4.5
to 5.8 GB (`app_docs/export.md`) and a cut-out at about 3.0 GB (`app_docs/pipeline.md`), so an
export and a new reel's heavy steps running together can pass the VM's memory, and each runs slower
than alone. Not measured together yet: watch the "Worker resources" dashboard on the first exports
that overlap an upload, and give the VM more memory if the tree comes near its total. Each job's
scratch folder, Chrome folders (`/tmp/hf-*`) and memory samples are its own, so two jobs never
read each other's files; `/tmp` holds up to three Chrome profiles of the export at once, as before
(only the export lane renders).

## Rules

- Never put a native program the worker runs outside the image: a new tool goes into
  `apps/worker/Dockerfile`, never behind a bridge to the Mac.
- Never change the MODNet pin in one place only: `modnet-model.ts` and the Dockerfile's `MODNET_*`
  `ARG` lines change together (`dockerfile.test.ts` checks it), with `MASK_TOOL_VERSION` when the
  masks change.
- Never download a model at job time in the container: the image carries the MODNet, U2Net,
  aligner and whisper models.
- Never change the aligner's pin in one place only: `align-model.ts` and the Dockerfile's `aligner`
  stage (`ALIGN_MODEL_REVISION`, the SHA-256, the file name) change together (`dockerfile.test.ts`
  checks it).
- Never put a secret in the image or in a compose file: secrets come only from the env file
  (`env_file`), and `.dockerignore` keeps every `.env*` file out of the build context.
- Never drop the empty `OTEL_EXPORTER_OTLP_HEADERS` from `compose.yaml`: it keeps a PostHog token in
  the env file from reaching local Grafana.

## Testing

- `yarn workspace @edit-issebya/worker test` (pure): `dockerfile.test.ts` (the committed models are
  copied with the worker's folder, the aligner stage's URL, revision, SHA-256 and copy match
  `align-model.ts`, `.dockerignore` keeps the local copy out), and `time-report.test.ts` (the GNU report branch the container uses).
- Manual (the owner's Mac, Docker Desktop): `docker compose build worker`, then the doctor in the
  container. The result of the last run is in the Notes.

## Notes

- The worker first ran in the container with Claude Code and Apple Vision (`vseg`) kept native on the
  Mac behind two HTTP bridges. Once every AI call went through OpenRouter and the cut-out became
  MODNet on the CPU, both bridges, their shims, token and ports were removed: nothing native is left.
- Chromium is Debian's, not the managed `chrome-headless-shell`, so HyperFrames logs its system-Chrome
  warning and falls back to screenshot capture (slower, same output).
- `compose.prod.yaml` replaces lists with `!override`. `!reset` would drop the attribute whatever
  value follows it (the env file, the environment and the volumes all gone); check with
  `docker compose -f compose.yaml -f compose.prod.yaml config --no-env-resolution`.
- Verified on the owner's Mac (Apple silicon, Docker Desktop with 8 CPUs and 8 GB), 2026-11-07:
  `docker compose build worker` (the `modnet` stage's download matched its size and SHA-256;
  `onnxruntime-node`'s `linux/arm64` binding present); the doctor in the container, every line `ok`
  (Supabase and R2 through the env file, ffmpeg 7.1.5, HyperFrames 0.8.222, the OpenRouter key set,
  `mask tool modnet 07c308cf, 1 s masked in 17.6 s`, `/scratch`); one real `change` job taken by
  `node src/once.ts` in the container: `decide` on `anthropic/claude-haiku-5.5` through OpenRouter
  (about $0.0026), one `behind` item, its cut-out a cache hit (the span's mask was already stored).
- MODNet speed on the 2.8 s sample clip, the same entry and model: about 11 s per second of footage
  natively on the Mac, about 19 s per second in the container (CPU only in both; Docker Desktop's VM
  is slower). A cut-out of a few seconds behind a big word takes about a minute in the container.
  That was mask tool version 2. Version 3 (the int8 model at 384, the crop above the head, the
  spans in parallel) takes about 2 s per second of footage in the container; see
  `app_docs/pipeline.md`.
