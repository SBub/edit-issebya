# The worker in a container (Docker Desktop on the owner's Mac, or any Linux host;
# arm64 or amd64). Built from the repository root (compose.yaml sets the context).
# Everything a job runs is inside: ffmpeg, HyperFrames with Chromium and whisper,
# the MODNet cut-out (onnxruntime-node on the CPU) and the AI calls (OpenRouter
# over HTTPS). See app_docs/worker-container.md.

# whisper-cli, the transcribe step's engine, built from a pinned whisper.cpp tag
# with the libraries linked in (one binary). HyperFrames finds it through
# HYPERFRAMES_WHISPER_PATH.
FROM node:24-trixie-slim AS whisper
ARG WHISPER_CPP_TAG=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git cmake build-essential \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_CPP_TAG}" https://github.com/ggml-org/whisper.cpp.git /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /src/build --config Release --target whisper-cli -j \
 && cp /src/build/bin/whisper-cli /whisper-cli

# The model HyperFrames' `small` names (ggml-small.bin), fetched at the revision
# HyperFrames pins and checked against its sha256, so the image holds the same file
# HyperFrames would download on first use.
FROM node:24-trixie-slim AS model
ARG WHISPER_MODEL_REVISION=5359861c739e955e79d9a303bcbc70fb988958b1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
RUN wget -q -O /ggml-small.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-small.bin" \
 && echo "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b  /ggml-small.bin" | sha256sum -c -

FROM node:24-trixie-slim AS runtime
# ffmpeg 7 (ffprobe's -show_stream_groups for HEIC photos); procps (ps, the
# process-tree memory sample); time (/usr/bin/time, the step measurements); the
# Chromium HyperFrames renders with, and fontconfig with fonts for it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg procps time chromium fontconfig fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /whisper-cli /opt/whisper/bin/whisper-cli
ENV HOME=/home/node \
    HYPERFRAMES_NO_TELEMETRY=1 \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium \
    HYPERFRAMES_WHISPER_PATH=/opt/whisper/bin/whisper-cli
# /scratch is owned by node, so the empty volume compose mounts there starts as node's.
RUN mkdir -p /home/node/.cache/hyperframes/whisper/models /scratch \
 && chown -R node:node /home/node /scratch
COPY --from=model --chown=node:node /ggml-small.bin /home/node/.cache/hyperframes/whisper/models/ggml-small.bin

# The worker's workspace and its two packages, with their dependencies only: the
# lockfile and every workspace's manifest, then `yarn workspaces focus`. It installs
# onnxruntime-node's prebuilt Linux binary for the image's platform (glibc).
WORKDIR /repo
ENV LEFTHOOK=0 YARN_ENABLE_TELEMETRY=0 CI=1
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/web/package.json apps/web/
COPY apps/studio/package.json apps/studio/
COPY apps/worker/package.json apps/worker/
COPY packages/edit/package.json packages/edit/
COPY packages/storage/package.json packages/storage/
RUN yarn workspaces focus @edit-issebya/worker

# The worker's source, and with it the cut-out's MODNet model, the head track's
# U2Net model and their notice (apps/worker/models, committed; each model's
# SHA-256 is checked before each run).
COPY apps/worker apps/worker
COPY packages/edit packages/edit
COPY packages/storage packages/storage
COPY fixtures/footage/short-speech.mp4 fixtures/footage/short-speech.mp4
COPY fixtures/photos/sample.jpg fixtures/photos/sample.jpg

USER node
WORKDIR /repo/apps/worker
CMD ["node", "src/main.ts"]
