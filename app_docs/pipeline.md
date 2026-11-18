# Fixed Pipeline Steps: Convert, Transcribe, Retime, Head Tracking, Previews

**Specifications:**

- specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md
- specs/issue-30-adw-47d9d58e-sdlc_planner-background-removal-head-tracking-previews.md
- specs/issue-94-adw-baceb379-sdlc_planner-remove-cutout-from-pipeline.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md

## Overview

After an upload the worker's `process` job runs five fixed steps as plain TypeScript, with no AI:
`convert` (phone footage to steady H.264), `transcribe` (the words from Whisper through
HyperFrames, each word's start and end from a forced aligner, and the spots where a word may be
missing heard again by a larger Whisper model), `retime` (a light speed-up and pause
cut planned from the transcript and the audio), `head_track` (the head position every
0.25 s, from its own sampled person mask) and `preview_copies` (a small copy of the footage for the
studio's live preview). Each step is cached in R2
by a fingerprint of everything it reads, so an input is processed exactly once and a failed job
resumes at the step that failed.

## How it works

The reel goes `converting`, `transcribing`, `retiming`, `tracking_head`,
`making_previews`, then `processed` (or `failed`). The studio's
live status shows one line per step (`name: summary`).

- `apps/worker/src/pipeline/definition.ts`: `PIPELINE = [convert, transcribe, retime, headTrack, previewCopies]` and
  `fingerprintsFor(source)`. A `PipelineStep` declares `name`, `version`, `settings`, `reelStatus`,
  `outputs` (each `{ file, retention }`, see Kept and rebuildable), `reusedWhat`, `inputs(source, fingerprints)` and `run`. A step reads only the local
  paths of its declared inputs.
- `apps/worker/src/pipeline/fingerprint.ts`, `canonical-json.ts`: the fingerprint is the SHA-256
  of the canonical JSON (sorted keys, no whitespace, refuses `undefined` and non-finite numbers) of
  `{ inputs, settings, version }`. The uploaded source is identified by its storage ETag and byte
  size (one HEAD, no download); a cached output by its producer (`{ step, fingerprint, file }`).
  Outputs live at `${R2_KEY_PREFIX}cache/<step>/<fingerprint>/<file>`.
- `apps/worker/src/pipeline/run-pipeline.ts`: for each step it HEADs every output key. All present:
  it sets the reel status, records a hit (`skipped`, `cache_hit = true`, summary `<what>, reused`)
  and spawns nothing. Every output it finds stored also records a `stored_files` row for the job's
  reel, from the `head` it already made. Otherwise it downloads the declared inputs into
  `<WORKER_SCRATCH_DIR>/<job id>/job-<job id>/` (the job's scratch folder, removed after the job), runs the step as one measured row, and uploads each missing
  output with put-if-absent, so a stored output is never replaced. The job folder is removed at the
  end; after a lost lease nothing more is written. A source with no ETag fails the job.
  `PipelineRun.setReelStatus` (default `true`) set to `false` never calls `steps.reelStatus`: the
  export's `runRender` uses it, so a render leaves the reel `processed` (`app_docs/export.md`).
- `apps/worker/src/pipeline/convert.ts`, `probe.ts`: ffprobe, then one ffmpeg encode: H.264 (crf 18,
  medium), constant 30 fps, a keyframe every 1 s, AAC audio copied when it already is AAC (else
  encoded at 256k), `+faststart`. HDR footage (`smpte2084` or `arib-std-b67`) is tone-mapped to SDR
  BT.709 (`zscale`/`tonemap`, hable); a variable frame rate (the two rates differ by more than
  0.5%, or `0/0`) becomes a steady 30. Output `converted.mp4`, written under a temporary name and
  renamed after exit 0.
- `apps/worker/src/pipeline/transcribe.ts`, `transcript.ts`, `tools.ts`: runs the installed
  HyperFrames binary (`process.execPath` plus its `bin/hyperframes.mjs`, `HYPERFRAMES_NO_TELEMETRY=1`
  forced) with `transcribe --engine whisper --model small --language en --json`. The words are
  normalised into the studio format `{ words: [{ id, text, start, end }] }` (seconds, three
  decimals, ids `w0001`... by position). Always the multilingual `small` model told the language:
  `small.en` and `base` drop or merge words on this footage. The HyperFrames version is a setting.
  Whisper's words are right but its times are not: on the owner's quieter footage (reel dfba7e04,
  116.7 s) it put "Friction" at 0.08 to 6.00 s (the voice starts at about 5.7 s), and 34 of 162
  words held 0.4 s or more of silence (37.7 s in all). So the step keeps Whisper's words and ids
  and takes every time from the aligner below (version 2; version 1 kept HyperFrames' times).
  Version 3 adds the re-listen, further down. The step's calls, in order: Whisper `small` on the
  whole clip, the aligner, ffmpeg for the envelope, then per spot one ffmpeg cut and Whisper
  `medium`, and the aligner once more when the words changed. Ids are given last, by position
  (`numberWords`), to the list the step writes.
- The word aligner (`align.ts`, `align-entry.ts`, `align-model.ts`), a second tool call of
  `transcribe`: the worker's Node runs `align-entry --input <converted.mp4> --words <heard.json>
--output <aligned.json> --threads <n> --model <onnx> --ffmpeg <path> --emissions <file>`
  (`alignArgs`). It checks the
  model against its pin, has ffmpeg decode the audio to 16 kHz mono floats (`alignDecodeArgs`), and
  runs wav2vec2-base-960h (an English CTC model that spells capitals, the apostrophe and a word
  separator) through `onnxruntime-node` on the CPU in pieces of 20 s with 1 s of audio heard but
  not kept on each side (`chunksOf`; the input zero mean and unit variance per piece, as the model
  was trained), one frame of letter probabilities per 20 ms. Then a CTC forced alignment
  (`forcedAlign`: the Viterbi path through blank, letter, blank, ... in order over the whole clip)
  places Whisper's words, spelled in the model's letters with the separator between them
  (`wordTokens`, `transcriptTokens`; accents dropped, punctuation and anything else the model cannot
  spell left out). A word lasts from its first letter's first frame to the end of its last letter's
  last frame (`alignedTranscript`). No rule of ours moves a time. The fallback, for a word with no
  letter the model spells (digits such as "2026", a symbol): such words take the gap between the
  placed words around them, split evenly in order (from the clip's start or to its end at the
  edges), so they are never cut; a transcript with no spellable word at all keeps Whisper's times.
  One `@hf-progress` line per piece. `ALIGN_SETTINGS` (the model and its SHA-256, the rate, the
  frame step, the receptive field, the piece and context lengths, `provider` `cpu`) is the `align`
  setting of transcribe, so another model re-runs it. The thread count (the machine's CPUs) is not
  a setting. On the dfba reel it took about 8.5 s (1.5 GB peak); 0 of 162 words now hold even
  0.2 s of silence, 0 start 0.2 s or more before their sound, 0 end 0.2 s or more into silence, and
  "Friction" is 5.66 to 6.06 s. The entry saves the model's letter probabilities (after the
  log-softmax) with the clip's sample count to `--emissions` (`packEmissions`); when that file is
  already there it reads them (`unpackEmissions`) and runs neither ffmpeg nor the model. That is
  how the re-listen's second alignment costs about a second instead of the model's run again.
  The step deletes the file before its first alignment, so a file from an earlier try is never read.
- The re-listen (`relisten.ts`, pure; run by `transcribe.ts`). Whisper `small` sometimes drops
  words: on the owner's reel b2170604 it wrote "together? And hugs" where she says "together? Warm
  meals made from local produce. And hugs", and the aligner stretched "And" over 1.2 s. The step
  looks for such spots, has Whisper `medium` hear a short window around each one, and takes its
  words only where both models agree on the words around them.
  1. Spots (`relistenSpots`), from the aligned words and the 10 ms envelope (`envelope.ts`, the
     same ffmpeg call retime makes). A gap spot: a stretch inside a gap of the transcript of at
     least `gapSeconds` (0.45 s) of envelope frames in a row within `gapBelowSpeechDb` (10 dB) of
     the clip's speech level. It is retime's `missedSpeech` (`speech-gaps.ts`) with a longer
     length, so every gap spot is also a possible missed word retime would keep. A stretched word
     (`stretchedWords`): its seconds per letter (the aligner's letters, `wordTokens`) are at least
     `stretchRatio` (3) times the clip's median, and it is at least `stretchExtraSeconds` (0.4 s)
     longer than the median would make it. Candidates closer than `joinSeconds` (1 s) are one spot.
  2. The window (`relistenWindow`, `windowArgs`): the old words that touch the spot and
     `windowWords` (3) more on each side, with up to `windowPadSeconds` (0.3 s) of the pause before
     and after, never more than half of that pause. ffmpeg cuts it to a 16 kHz mono WAV.
  3. Whisper `medium` hears the window through the same HyperFrames call as `small`
     (`transcribeArgs` with `--model medium`). HyperFrames, not `whisper-cli` directly, because
     it already finds the binary on every machine, passes the same arguments (0.8.222:
     `--output-json-full --suppress-nst --language en`), pins `ggml-medium.bin` by size and
     SHA-256, and groups tokens into words the same way as for the whole clip, so the two word
     lists compare like for like. Only the texts are read (`heardTexts`).
  4. The merge (`mergeHeard`): the window's old words and the heard ones are matched in order
     (the longest common run of the same words, compared without capitals, accents and
     punctuation). The nearest matched old word ending before the spot and the nearest one
     starting after it are the anchors; only the words between them can change. Without an anchor
     on one side the old words stay (so a spot at the very start or end of the clip is never
     changed), and the same words heard again change nothing. Between the anchors the heard words
     are taken, except where they would only swap old words that lie wholly outside the spot for
     other words: there the old words stay (on the ten-second fixture `medium` hears "earn" as
     "earth" right after the spot). Replacements of several spots are made in order; one that
     overlaps an earlier one is dropped (`applyReplacements`).
  5. The writing at the join (`joinWriting`), three rules, because a window is a fragment and
     Whisper writes it without the sentences of the whole clip: a re-heard word that is one of
     the old words it replaces keeps the old writing (capital and punctuation); an old word that
     started a sentence (a capital, after a word ending in `.`, `?` or `!`) still starts one, so
     the word now before it gets a full stop when it ends in a letter or a digit ("produce. And
     hugs"); a new word right after a word ending in `.`, `?` or `!` gets a capital. Nothing else
     is rewritten.
  6. When a replacement was made, the new list (the new words spread evenly between their
     neighbours as placeholders) goes through the aligner again, which times every word, and the
     step numbers the result. Otherwise the first alignment is the output.
     The step line: `transcribed, 95 words, 1 spot re-listened, 6 words added` (`relistenSummary`;
     also `1 word removed`, `words changed`, or `no change` when every window was a false alarm);
     with no spot it is `transcribed, 89 words`, as before. `RELISTEN_SETTINGS` (the model's name and
     SHA-256 and every threshold above) is the `relisten` setting of transcribe. Measured natively on
     the owner's Mac (M3, whisper.cpp on Metal), reel b2170604 (113 s): Whisper `small` 4.9 s, the
     aligner 7.9 s, the envelope 1.4 s, the window cut 0.1 s, Whisper `medium` on the 13.7 s window
     3.7 s, the second alignment 1.3 s; 89 words became 95. On four other reels of the owner (91 to
     162 words) no spot was found, so nothing was heard twice. In the worker container Whisper runs
     on the CPU and `medium` holds about 2.1 GB at its peak (the prototype's measurement).
     What it does not catch: a short dropped word in fast speech leaves less than 0.45 s of sound in
     its gap and stretches no neighbour enough; on the ten-second fixture, taking out "distribution"
     or "project," gives no spot.
- The re-listen's model (`whisper-model.ts`, `RELISTEN_MODEL`): `ggml-medium.bin` of
  ggerganov/whisper.cpp at the revision HyperFrames pins
  (`5359861c739e955e79d9a303bcbc70fb988958b1`), 1,533,763,059 bytes, SHA-256
  `6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208` (HyperFrames' own pin for
  `medium`). It lives where HyperFrames looks for its models,
  `~/.cache/hyperframes/whisper/models/` (`relistenModelPath`), outside the repository, so neither
  `.gitignore` nor `.dockerignore` names it. `models:fetch` fetches it there and the worker
  image's `model` build stage puts it in the image; never at job time. Before the first window of
  a run the step checks the file's size and SHA-256 (`verifyRelistenModel`): a missing or changed
  file fails transcribe with `whisper medium model missing at <path>, restore it with yarn
workspace @edit-issebya/worker models:fetch`, so HyperFrames never downloads 1.5 GB inside a job.
  A clip with no spot never needs the file.
- Saved versions and a new transcribe version. Every version of a reel names the exact outputs
  it was built from (`inputs`: retime's `transcript.json` and `source.mp4`, the head track, each
  by step and fingerprint, written once by `first_version` and copied by every later version).
  The preview, restore, the font pair relayout, the owner's edits and Start over all read those
  stored outputs, which are `kept`, so a reel made before version 3 keeps its old transcript and
  its old word ids for good and its versions load as before: no job pairs an old version's word
  ids with a new transcript. Two things do change for such a reel. An export first runs the
  current pipeline (`runRender`), which now makes new outputs the old version does not use (once,
  then they are hits), and then renders from the version's own inputs; if slimming already
  cleared the old `source.mp4` (the reel was last exported more than seven days ago), the
  pipeline cannot make that file again, and the export fails with `render: input missing: <key>:
this version was made by an earlier version of the retime step, its source.mp4 was cleared to save
space and can no longer be made again; upload the footage again as a new reel` (`missingInput`,
  `render-step.ts`). That is true of every step version change, not only this one. And a `process`
  job run again on a reel that already has a version (a retry after a failed decide) no longer
  overwrites `reels.preview_copies` (`keepsPreviewCopies`): the new copies would show new cuts
  under the old versions' words.
- The aligner's model (`align-model.ts`, `ALIGN_MODEL`): the float32 ONNX export of
  facebook/wav2vec2-base-960h (Apache 2.0) published by Xenova/wav2vec2-base-960h, revision
  `a19f851b3d42865797e410752b4c570c871e4825`, `onnx/model.onnx`, unchanged, 377,887,594
  bytes, SHA-256 `e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d`. Too large to
  commit, so it is fetched from that URL into `apps/worker/models/` (gitignored) by
  `yarn workspace @edit-issebya/worker models:fetch` (`fetch-models.ts`: kept when it already
  matches its pin, else fetched to `.part`, checked, renamed) and by the worker image's `aligner`
  build stage (`app_docs/worker-container.md`); never at job time. A missing or changed file fails
  the entry with `wav2vec2 model missing at <path>, restore it with yarn workspace
@edit-issebya/worker models:fetch`. Its notice is in `apps/worker/models/THIRD_PARTY_NOTICES.md`.
  Why float32: the two smaller exports are out. The float16 one (`onnx/model_fp16.onnx`, 189 MB)
  places every word within one 20 ms frame of it on dfba, but crashes onnxruntime-node 1.31.1 on
  Linux arm64 (the worker container on the owner's Mac) as soon as a session is created (heap
  corruption, the process aborts), so every upload failed at transcribe; it runs on macOS. The int8
  export (95 MB, the smallest) put whole words up to 5 s off (the closing "care of." on a later
  untranscribed "yes").
- `apps/worker/src/pipeline/envelope.ts`, `speech-gaps.ts`, `retime-plan.ts`, `retime-encode.ts`,
  `retime.ts`: a 10 ms RMS envelope in dB, what the audio says about the transcript's gaps (the
  gaps, the clip's speech level, `missedSpeech`; shared with transcribe's re-listen), a pure planner
  and one ffmpeg encode. Outputs `source.mp4` (retimed footage),
  `transcript.json` (same ids, every time through the plan), `retime.json` (the plan: original to
  new time map) and `envelope.json`. The step line ends with the pauses the final re-check found,
  if any, and with every possible missed word it kept, at its retimed time (`retimeSummary`:
  `retimed to 56.1 seconds, 1.05x, 1 pause over 0.3 s left, 0.4 s in all, 1 possible missed word
kept (sound at speech level in a pause) at 49.6 to 50.0 s`).
- `apps/worker/src/pipeline/retime-preset.ts`: `RETIME_PRESET`, every retime setting; each value is
  part of the fingerprint.
- `apps/worker/src/pipeline/u2net.ts` and `u2net-entry.ts`: the person mask `head_track` reads,
  made by the worker's own U2Net entry through `onnxruntime-node` on the CPU, with the committed
  int8 model (`u2net-model.ts`, below). The entry is run by the worker's Node, one tool call per
  chunk of the sample clip: `u2net-entry --input <samples.mp4> --first <sample> --frames <count>
--output <rgba> --threads <n> --model <onnx> --ffmpeg <path>` (`u2netArgs`). It checks the model
  against its pin, decodes its samples with ffmpeg (`u2netDecodeArgs`: `-ss` at the chunk's first
  sample, the sample filter, `-frames:v`, raw RGB on stdout) and masks each frame on its own, the
  way HyperFrames' background removal does with `u2net_human_seg` (0.8.222, the tool this step
  used until version 3): the frame scaled to 320x320 with `sharp` (lanczos3), divided by its
  largest value, the ImageNet mean taken off and divided by the deviation (`u2netInput`); the
  model's first output stretched from its smallest to its largest value over 0 to 255
  (`u2netMask`) and scaled back to 270x480 (lanczos3). Each mask is written as the alpha of a raw
  RGBA frame (`<output>.part`, renamed when done). Exactly `--frames` frames or the entry fails;
  any failure exits 1 with one `u2net: ...` line. It prints one `@hf-progress` line per frame
  (`app_docs/status.md`). `sharp` is pinned exactly in `apps/worker/package.json`, at the version
  HyperFrames installs. `U2NET_SETTINGS` (the model and its SHA-256, the input size, the resize
  kernel, `provider` `cpu`, the mask file's `crf` and `cpuUsed`) is part of the step's fingerprint.
- The chunks (`maskPool`, `chunkBounds`, `MASK_POOL`): the samples are split into at most 4 runs
  of the same length, masked at once, as many as there are CPUs and memory for (half the memory
  limit, each chunk counted as 512 MB: one entry with its ffmpeg peaks at about 440 MB), the CPUs
  shared out evenly as ONNX intra-op threads (8 CPUs: 4 chunks of 2 threads; 1 CPU: one chunk).
  The limits are the cut-out's (`machineLimits`, `cutout/pool.ts`). No frame depends on another,
  and one encode joins every chunk, so the track is the same, byte for byte, whatever the split
  (`head-track.tools.test.ts` runs one chunk, four and the machine's own); the split is therefore
  not a setting.
- `apps/worker/src/pipeline/head-track.ts`: the pure tracker, `HEAD_TRACK_SETTINGS`, `headSample`,
  `withinBounds`, `headTrackWhat`; tested on synthetic frames without ffmpeg.
- `apps/worker/src/pipeline/head-track-step.ts` (`headTrackStep`, `headTrack`): reads retime's
  `source.mp4`. ffmpeg keeps one frame per 0.25 s at 270x480, losslessly (yuv444p), in a scratch
  `samples.mp4` (`headTrackSampleArgs`); ffprobe counts its frames (`sampleCountArgs`); the U2Net
  entry masks them in chunks run at once into scratch `mask-<n>.rgba` files (each call's memory
  sampled with its ffmpeg's, `sampleGroupMemory`; each chunk's progress weighted by its samples,
  `weightedProgress`); ffmpeg joins the chunks in order (`maskEncodeArgs`, the `concat:` protocol)
  into a scratch VP9-alpha `mask.part.webm`, with the arguments HyperFrames encodes its `.webm`
  with at `balanced` quality (`-crf 18 -cpu-used 4`, BT.709 video range); ffmpeg decodes it
  (`headTrackDecodeArgs`, `-c:v libvpx-vp9` before `-i`, so alpha survives) to raw RGBA in a
  scratch `frames.rgba` (stdout through the step runner is capped at 64 KB and a call over its cap fails, so it cannot carry
  frames), read back one frame at a time. The VP9 round trip is kept from version 2 on purpose: the
  tracker sees what it saw then, so the int8 weights are the only change to the mask. Every scratch
  file is deleted in the step, never uploaded. Version 3 (2 ran HyperFrames' `removeBackground`
  with the fp32 `u2net_human_seg` in one process; tracks stored under 2 stay with the reels that
  name them); its settings are the tracker's plus `mask` (`HEAD_TRACK_STEP_SETTINGS`, the model's
  SHA-256 among them, so another model re-runs it). Output `head-track.json` (format unchanged).
  A sample clip without frames, a failed chunk, zero frames or a trailing partial frame fails the
  step.
- `head_track` speed, measured in the worker container on the owner's Mac (M3, 8 CPUs, Docker),
  on four reels of about 27 to 55 s (106, 131, 193 and 218 samples): 17.9, 17.9, 29.3 and 28.5 s, 94 s
  together, about 0.14 s per sample; version 2 took 55, 69, 103 and 116 s (343 s, about 0.53 s
  per sample). CPU time 105 to 181 s a reel against 369 to 774 s; the largest process holds about
  440 MB (version 2: 686 MB in one process), four at once. The tracks are not version 2's: against
  it the head top moves by 0.6 to 1.1 px on average on three of the reels and by 16 px on the
  fourth (p95 4 px and 120 px, largest 172 px), the head width by 1 to 2 px and 44 px. What was
  checked instead is the layout: with the saved edits of the four reels re-placed over the new
  tracks, no on-screen item newly covers the face (16 face hits before, the same 16 after). The
  model alone gives the speed: version 2's fp32 model in the same four chunks took 305 s. Two of
  the four reels gave the model's calibration frames, so the other two are the clean test.
- The on-demand cut-out (`apps/worker/src/cutout/`): `ensure-cutouts.ts` makes the person mask of
  each padded span of an edit's big words (`behind` items behind the speaker; a VISUAL needs none)
  that is not stored yet, in one measured `cutout` step, one tool call per span, several spans at
  the same time (the pool, below).
  The tool is MODNet portrait matting (ZHKKKe/MODNet, Apache 2.0 code and weights, its weights
  quantised to int8, see the model below) run through `onnxruntime-node` on the CPU, on any OS
  (Linux and Docker included): `mask-tool.ts` (`maskToolCall`, `MASK_TOOL_VERSION` 3) runs this
  Node on `modnet-entry.ts` with `--input --start --end --output --crop-top --threads --model
--ffmpeg --ffprobe`.
  The entry checks the model's SHA-256, probes the footage's size and frame rate, and streams:
  ffmpeg decodes exactly `round((end - start) * fps)` frames from the span's first frame (seeking a
  quarter frame early, `-frames:v`) to raw RGB at the working size (`workingSize` in
  `matte.ts`: the short side 384, both sides rounded down to multiples of 32, the aspect kept, area
  scaling, so 1080x1920 and 720x1280 run at 384x672 uncropped; MODNet's own reference is 512, and
  384 is about 1.7 times faster with masks that look the same), without the rows above the crop
  (below); each frame is normalised to -1 to 1 (NCHW
  float32) and run; the matte (0 to 1) becomes 8-bit gray, goes through a 3-frame per-pixel
  temporal median (`TemporalMedian`: frame i is the median of frames i - 1, i, i + 1, the first and
  last unchanged; it removes one-frame flicker without the lag a moving average leaves on motion;
  one frame of delay, three mattes held) and into a second ffmpeg, which scales it to its rows of
  the footage (bicubic), fills the rows above the crop black (background, `pad`), and writes the
  mask at the footage's size: H.264 High `yuv420p`, full-range gray mapped to video range
  (white = person, chroma neutral), BT.709 tags, crf 12, a keyframe every second, frame i at
  i / fps, the span's frame count. The same format, keys and layout the Apple Vision tool (`vseg`,
  removed) wrote, so the builder, the preview and the export read it unchanged. Written to
  `<output>.part`, renamed when done; one `@hf-progress` line per frame (`app_docs/status.md`); any
  failure exits 1 with one `modnet: ...` line. Speed, measured
  2026-11-11 in the worker image on Docker Desktop (M3, 8 CPUs, 7.75 GiB), the real entry on one
  reel's six spans (13.7 s of 1080x1920 at 30 fps, crops of 300 to 390 rows): 27 to 30 s for the
  whole step at 3 spans at a time (what that VM's memory allows; about 3.0 GB held at the peak,
  170 to 190 s of CPU), 24 s at 6 at a time (5.2 GB), so about 2 s per second of footage. Version
  2 took 254 s for the same spans (about 19 s per second). Against version 2's masks the mean IoU
  is 0.9937 (worst frame 0.958). One span alone on one thread: about 0.14 s a frame.
- The MODNet model (`apps/worker/src/cutout/modnet-model.ts`, `MODNET_MODEL`): the committed file
  `apps/worker/models/modnet_int8_13.onnx`, pinned by name, size (6,912,985 bytes) and SHA-256
  (`a293b5ae8fb8ac81447a82bf1ad661479fb412fe2d276188711386c6c81df28b`). It is committed because it
  is a modified file that no official URL serves: the official
  `modnet_photographic_portrait_matting.onnx` of ZHKKKe/MODNet (the Google Drive file its ONNX
  README links, 25,888,640 bytes, SHA-256
  `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`) with its weights and
  activations quantised to int8. How it was made, with ONNX Runtime 1.31.1's quantization tool:
  `quant_pre_process` (symbolic shape inference skipped), the graph converted from opset 11 to 13
  (per-channel `DequantizeLinear` needs 13), then `quantize_static` in the QDQ format, per-channel
  int8 weights, int8 activations, MinMax calibration on 16 frames of one talking-head clip, taken
  evenly over it and scaled to 384x512. The calibration footage and frames are not in the
  repository. The licence notice sits beside the file (`apps/worker/models/THIRD_PARTY_NOTICES.md`:
  the attribution, the statement that the file is modified, and the full Apache 2.0 text), and
  `modnet-model.test.ts` checks both the file and the notice. Nothing is downloaded, at install or
  at job time; the worker image gets the file with the worker's folder. A missing file fails the
  `cutout` step with `cutout: MODNet model missing at <path>, restore it with git checkout --
apps/worker/models/modnet_int8_13.onnx`; a file with another size or hash fails the entry
  (`verifyModel`), naming both.
- The U2Net model (`apps/worker/src/pipeline/u2net-model.ts`, `U2NET_MODEL`), the head track's
  person mask model: the committed file `apps/worker/models/u2net_int8_static13.onnx`, pinned by
  name, size (44,444,038 bytes) and SHA-256
  (`a42be65f30af575480020f4d827eabadf73c8cdfd8f77577d2946780f54dc746`). It is committed because it
  is a modified file that no official URL serves: the `u2net_human_seg.onnx` copy of U-2-Net's
  human segmentation model (xuebinqin/U-2-Net, Apache 2.0) that HyperFrames downloads
  (`https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx`,
  175,997,641 bytes, SHA-256 `01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c`)
  with its weights and activations quantised to int8. How it was made, with ONNX Runtime's
  quantization tool: the graph converted from opset 11 to 13 (the output did not change, largest
  difference 0), then `quantize_static` in the QDQ format, per-channel int8 weights, int8
  activations, MinMax calibration on 16 frames, 8 taken evenly from each of two of the owner's
  reels (the step's own 270x480 samples, prepared as the step prepares a frame). The calibration
  footage and frames are not in the repository. Its notice is in the same
  `THIRD_PARTY_NOTICES.md`, and `u2net-model.test.ts` checks both the file and the notice. Nothing
  is downloaded; a missing file or one with another size or hash fails `verifyU2netModel`, naming
  the path and `git checkout -- apps/worker/models/u2net_int8_static13.onnx`. Both pins share
  `apps/worker/src/model-file.ts` (`ModelFile`, `modelPath`, `verifyModelFile`).
- The crop above the head (`crop.ts`, `spanCropTop`, `CROP_RULE`): the model never sees the rows
  above the speaker, which are wall, and the mask has them black. It comes from the head track
  (`head-track.json`, which every reel has before any cut-out: decide and relayout have it loaded,
  a stored version's is read from storage by `version-cutouts.ts`), never from a fixed height. For
  each span: of the samples from 0.25 s before the span to 0.25 s after it, the smallest `head_top`
  (the top of the person mask, so a raised hand counts) minus half the widest `head_w`, never
  below 0, in the head track's 1080x1920 pixels (the track has no head height; the width is its
  measure of the head). No crop (0) without a head track, without a sample in the span, or when
  one of the span's samples has no head. The entry gets it as `--crop-top <px>` and
  `matteRegion` (`matte.ts`) turns it into the footage rows the model runs on: scaled to the
  footage's height, then moved up (never down) until the region scales, at the frame's own scale,
  to a whole multiple of 32 rows, and starts on an even row. A crop that moves up to row 0 is no
  crop. Example, 1080x1920 with the person's top at 560 and a head 412 wide: `--crop-top 354`,
  rows from 300 down (1620 rows), run at 384x576 instead of 384x672.
- The pool (`pool.ts`, `cutoutPool`, `runPool`): the span calls of one `cutout` step run at the
  same time, the longest span first. How many at once is the smallest of the spans to make, the
  CPUs (`os.availableParallelism()`) and what memory allows: half the memory limit
  (`CUTOUT_POOL.memoryShare`; the limit is the container's when it has one,
  `process.constrainedMemory()`, else the machine's) divided by 1 GiB per call
  (`CUTOUT_POOL.processBytes`: one call, the entry and its two ffmpegs together, was measured at
  about 0.9 GB on 1080x1920 footage, of which the entry is 0.35 GB and the mask encoder 0.5 GB),
  and never less than one. Neither compose file sets a CPU or memory limit on the worker, so in
  Docker Desktop the limits are the VM's: with its 8 CPUs and 7.75 GiB, 3 spans at a time. The
  CPUs are shared out as ONNX intra-op threads (`--threads`, inter-op 1): every span starts with
  one, and one more goes, again and again, to the span with the most footage per thread, unless
  the busiest calls that can run together would then have more threads than there are CPUs. So
  the longest span, which decides how long the step lasts, gets the spare CPUs (six spans on 8
  CPUs with room for all: 1 thread each and 3 for the long one). The two ffmpegs of a call keep
  their own threads: limiting them saved about 0.1 GB a call and no time. A failed span stops the
  spans not yet started; the step fails once the running ones have ended, and a mask whose span
  ended well is already stored, so the next run of the job reuses it. The step's measurement (CPU summed, peak
  memory of the calls that ran together, each call's whole process tree sampled) is in
  `app_docs/measurement.md`; its progress in `app_docs/status.md`.
- A mask's fingerprint (`maskFingerprint` in `spans.ts`): the footage ref, the span, its
  `cropTop`, and `MATTE_SETTINGS` (`model`, `modelSha256`, `size` 384, `crop`
  `above-head-half-width` (`CROP_RULE.id`), `smoothing` `median3`, `provider` `cpu`,
  `format` `h264-gray`), version `MASK_TOOL_VERSION`. So `plannedMasks` and `withMasks` take the
  head track. Version 1 was `vseg`, version 2 the fp32 model at 512 over the whole frame;
  version 3 (the int8 model, 384, the crop) makes new masks for new runs, while stored versions
  keep naming (and rendering) the masks of the version that made them: nothing rewrites or
  deletes a stored mask. Change `CROP_RULE.id` with any value of the rule. Bump the
  version whenever `modnet-entry.ts` or `matte.ts` changes what a mask looks like. CoreML (in
  `onnxruntime-node` on the Mac) was tried: slower than the CPU on an M3 and with other values, so
  the provider is `cpu` everywhere.
- `apps/worker/src/pipeline/preview-copies.ts`: one encode, `footage-preview.mp4` (H.264, 540x960)
  from the retimed `source.mp4`, version 2; `PREVIEW_SETTINGS` holds every value.
- `apps/worker/src/step-runner.ts`: `runToolsStep` (one row over several tool calls, CPU summed,
  peak memory the maximum) and `recordHit`; see `app_docs/measurement.md`.
- `packages/storage`: `head` returns the ETag, `getFile` streams to `<path>.part` then renames,
  `putFileIfAbsent` never replaces an object (R2 `If-None-Match: *`, 412 means exists; the folder
  fake hard-links a finished temp file), and `keyPrefix` lives here.
- `supabase/migrations/20261101100000_pipeline_steps.sql`: `steps.cache_hit`, step status
  `skipped`, reel statuses `converting`, `transcribing`, `retiming`, `processed` (`received` stays
  allowed for old rows; nothing writes it).
- `supabase/migrations/20261101135426_pipeline_steps_part_two.sql`: adds the reel statuses
  `removing_background`, `tracking_head`, `making_previews`. `tracking_head` and `making_previews`
  are mirrored in `PipelineReelStatus` (`apps/worker/src/step-store.ts`); all three are in
  `REEL_STATUSES` (`apps/studio/src/lib/reels.ts`). `removing_background` stays allowed for old reels
  and in `REEL_STATUSES`, but is no longer in `PipelineReelStatus` and nothing writes it.
- `apps/worker/src/first-version.ts`: after the five steps the worker saves the automatic first
  version, the `first_version` step: version 1 built from the preset alone (no AI) from the retimed
  transcript, `retime.json`'s duration and the head track, its captions placed by the layout
  engine, saved through `save_version` with the engine record. Its step
  line is `version 1 saved, <time>, <size>`, or `first version kept, reused` (a cache hit, nothing
  written) when the reel already has a current version. Failed layout checks are stored on the
  version, never fatal. See `app_docs/edit-model.md`.

### Head-track format

`head-track.json` is an array with one entry per 0.25 s (entry `i` is `t = i * 0.25`), each either
`null` (no head found) or `{ t, head_top, cx, head_w }` in 1080x1920 coordinates (the same format as
the old `head_track.py`). A frame is analysed at 270x480 and the numbers are scaled by 4. A pixel is
opaque when alpha is above 128. The top is the first row with at least 4 opaque pixels; `head_top`
is one analysis row above it (`headTopMargin`, 4 px, never above the frame), a safety margin added
with the int8 mask of version 3: with it, no cut-out crop (`spanCropTop`) over a span with a head
on the four test reels is lower than with version 2's mask, and none reaches a real head top (three
spans were lower without it, by 4 px at most). A span where version 2 found no head in one sample
had no crop then and can have one now. For the rows
20 to 49 below the first opaque row, each row with an opaque pixel gives a span (first to last opaque x); the spans
are sorted by width and the median one gives `cx` and `head_w`. Coordinates stay in 1080x1920 space
for a source of another size. The optional bounds (`minHeadTop`, `minHeadWidth`, `maxHeadWidth`)
default to none: the old values (380, 220, 420) fitted one room and are not a default. A clip with no
person gives all `null` (summary `head tracked, 12 samples, 12 without a head`).

### Preview copies

The footage preview is 540x960 with the source's frame timing (`-fps_mode passthrough`) and a
keyframe every 1 s: H.264 medium, 1200k (max 1500k), AAC 128k, `+faststart`. About 8 MB for a 50 s
reel and about 50 MB for 5 minutes; made for Chrome.

The frames sprite (`frames.jpg`, `FOOTAGE_FRAMES`, version 4) holds one 90x160 frame every 2 s in
rows of 32 (64 s a row), filled left to right and top to bottom (`tile=32x5`). Its row count is
`ceil(FOOTAGE_LIMITS.maxSeconds / 64)`, 5 rows (2880x800) for 5 minutes, so every frame of the
longest accepted footage has a tile; a shorter reel leaves the later tiles black (the short-speech
fixture's sprite is 14 KB). `frames_layout` in `reels.preview_copies` carries `rows`; a version 3
layout has none and the studio reads it as one row.

### Longer footage (5 minutes)

The footage limit went from 90 s to 5 minutes (2026-11-17). What was checked downstream:

- Frames sprite: version 3 had one row of 32 frames (64 s), so a reel past 64 s already repeated
  its last frame in the timeline. Version 4 has rows for the whole limit (above), and the studio's
  `frameIndexAt` and `frameTileAt` read them.
- Transcribe: whisper.cpp runs locally through HyperFrames and walks long audio in Whisper's own
  30 s windows: no request and no size limit. HyperFrames' own timeout scales with the audio (10 s per
  second, at least 5 minutes), so 5 minutes of footage has 50 minutes.
- Decide: the target picks scale with the speech (`targetPicks`), and the answer stays far under
  `MAX_OUTPUT_TOKENS` (16,000). The answer schema inlines the enum of every word id 12 times, so
  it grows with the script: about 23 KB at 225 words (90 s), about 74 KB at 750 words (5 minutes).
  The JSON mode fallback appends the same schema to the prompt. Not changed; watch the first long
  reels' decide calls.
- Head track: 4 samples a second, so 1,200 samples for 5 minutes, about 0.14 s a sample (about
  3 minutes) in the same four chunks; memory per chunk does not grow. Its scratch files are raw
  RGBA at 270x480 (about 0.5 MB a sample): the masks and `frames.rgba` together about 1.3 GB at
  5 minutes, well under `WORKER_MIN_FREE_DISK_GB` (10).
- Cut-out: made per padded span of a big word, never for the whole footage; a longer reel has more
  spans, about 2 s per second of span.
- Job and step time: no step has a timeout; the lease (300 s) is renewed while a job runs. Only one
  AI call has a budget (180 s), and it does not depend on the footage length.
- Export: a reel of 120 s or more (`COMPOSITE_MAX_SECONDS`) takes the slower single call
  (`long_reel`, `app_docs/export.md`). Known and unchanged.

### Kept and rebuildable

Every output carries a tag, so the slimming (`app_docs/storage.md`) can act on it. `kept` cannot be regenerated
cheaply and stays; `rebuildable` is heavy and may be deleted, since its step re-runs from the
fingerprint. Tags are not part of a fingerprint.

- `rebuildable`: `converted.mp4`, retime's `source.mp4` and the on-demand `cutout` step's
  `mask.mp4` (`ON_DEMAND_OUTPUTS` in `definition.ts`, read by `retentionOf`): the next export,
  restore or Start over makes it again. The retired `backgrounds` step's `backgrounds.json` (removed
  with readability) is `rebuildable` too, listed under `RETIRED_OUTPUTS`, so old reels' copies are
  still classified and slimmed; nothing makes it again.
- `kept`: `transcript.json` (transcribe and retime), `retime.json`, `envelope.json`,
  `head-track.json`, `footage-preview.mp4`.
- Retired outputs (`remove_background`'s `subject.webm`, rebuildable, and `preview_copies`'
  `subject-preview.webm`, kept) are still classified by `retentionOf` through `RETIRED_OUTPUTS`
  (`definition.ts`) for old reels' stored files, and never written again.

### Retime rules

1. Pauses come from the transcript first; the audio is a safety check only. The transcript
   protects speech: every word's span, from its start to its end (the aligner's times), is never
   cut. Its gaps (before the first word, between neighbouring words from the latest end so far to
   the next start, after the last word) are the pauses, whatever their loudness: room noise, a
   breath, a click or a movement in a gap is part of the pause. The one exception is a possible
   missed word (`missedSpeech`): a stretch inside a gap of at least `missedSpeechSeconds` of
   10 ms frames in a row, each no more than `missedSpeechBelowSpeechDb` under the clip's speech
   level. The speech level (`speechLevel`) is the median level of the frames inside the words'
   spans; a clip with no frame inside a word has none, and then nothing is held back. Such a
   stretch is kept whole and splits its gap into the pause before it and the pause after it, each
   treated like any other pause (rule 5), so about half of a kept pause stays on each side of it
   as its margin. A shorter burst is not one. Phrases are the words between pauses of at least
   `phraseGapSeconds`.
2. A phrase is slow when its words per second are under `slowWordsPerSecond`, it holds a word longer
   than `drawnOutWordSeconds`, or a pause of `longPauseSeconds` or more follows it. Adjacent slow
   phrases merge; a stretch shorter than `minSlowStretchSeconds` stays at base speed.
3. Every speed boundary sits on a frame point strictly inside a pause, never inside a word.
4. A pause between words shorter than `minGapAfterSeconds` after speed-up that holds a whole frame
   has that middle frame slowed to `gapRate`, but only when the frame is quiet: every 10 ms
   envelope frame that touches it is at least `gapQuietBelowSpeechDb` under the clip's speech
   level (rule 1's level; a frame past the audio's end is quiet, and with no speech level no
   frame is). A frame that is not quiet keeps its speed, and the gap stays as short as it was
   spoken. A rate under 1x is a plain rate change (`asetrate`), which drops the pitch by the same
   share (about 40% at 0.6): on room tone nobody hears it, on a voice it is a short deep blip.
5. Pause cutting: when `maxPauseSeconds` is a number (the default, 0.3), every pause longer than
   that once sped up is shortened to it. A pause between two words (or a word and a kept possible
   missed word) loses whole frames around its
   middle, so it plays as `maxPauseSeconds` (give or take a frame, about half kept on each side);
   the pause from the clip's start and the one reaching the end of the audio lose the part away
   from the speech, so `maxPauseSeconds` stays next to it. Every cut point is a frame point
   strictly inside its pause. A pause must be longer than `maxPauseSeconds` at its speed (about
   0.32 s) to be cut at all. Audio and video of a piece are trimmed at the same frame, so a cut adds
   no drift. A pause at a speed boundary keeps its boundary inside the pause; its two halves play
   at their own speeds. Short-gap frames (rule 4) never reach the limit, so the two rules never
   meet. `null` cuts nothing. `retime.json` maps original to new time (a time inside a cut maps to
   the cut point).
6. Word times: retime's `transcript.json` (same ids, same order) is the transcribe step's, every
   time through `retime.json` (`retimeTranscript`). No word time lies in a cut, so none is moved;
   starts never decrease, no word ends before it starts, and no time passes the clip's end.
7. The last piece carries an `endFadeSeconds` audio fade; the end is the duration rounded to a frame,
   or the trailing trim point (still in the pause, so the fade falls on the pause). At every join
   of two pieces (a cut, or a change of speed) the sound of the piece before fades out over
   `joinFadeSeconds` and the sound of the piece after fades in over it (`retimeFilterGraph`,
   `afade` by sample position after the piece's trim): a pause is not silent (rule 1), so a join
   often falls inside a breath or room sound, and two pieces set end to end there click. A fade
   only scales samples the piece already holds: no piece changes length, the sound keeps its
   total length and its place against the picture, and the video pieces are never faded or moved.
   A piece shorter than two fades gets half its length for each.
8. The final re-check (`pausesLeft`) names, in the step line, what is still longer than
   `maxPauseSeconds` plus a frame on the retimed timeline: a pause of the transcript the plan
   could not shorten, and a stretch inside the words' spans with no frame at speech level (rule
   1's level), which retime never cuts: it shows where a word's span still holds a pause (a word
   the aligner could not spell takes the whole gap around it). The step line also names every
   possible missed word kept (rule 1) with its retimed time, so the owner can listen to it.

`RETIME_PRESET` defaults: `baseSpeed` 1.05, `slowSpeed` 1.1, `slowWordsPerSecond` 2.7,
`drawnOutWordSeconds` 0.6, `longPauseSeconds` 0.3, `phraseGapSeconds` 0.1,
`minSlowStretchSeconds` 0.8, `missedSpeechBelowSpeechDb` 10, `missedSpeechSeconds` 0.25,
`envelopeFrameSeconds` 0.01, `minGapAfterSeconds` 0.065, `gapRate` 0.6, `gapQuietBelowSpeechDb` 20,
`maxPauseSeconds` 0.3, `frameRate` 30, `joinFadeSeconds` 0.005, `endFadeSeconds` 0.03, plus the encode settings (`libx264`, `medium`, crf 18, `256k`).

Pause cutting is always on: the owner switched `maxPauseSeconds` from `null` to 0.4 on 2026-11-04
as the first step toward the rough cut (#166), with no per-reel switch, and lowered it to 0.3 on
2026-11-04 (tighter pauses between words and at the clip's start and end; a settings change, so
the fingerprint changes and retime re-runs without a version bump). Retime version 2 added the
leading and trailing trim but trusted the transcript's word intervals (no cut under a word); version
3 (owner decision 2026-11-04) cuts and times words by the audio instead, and replaces a separate
transcript timing fix: whisper (`small`, through HyperFrames) pins the first word at 0 across
leading silence and starts a word after a long pause inside it (reel IMG_2013: "There" at 0 with
speech from about 3.5 s, so version 2 trimmed nothing and captions showed up to 3 s early). A cut
joins two frames of the same take, so the picture may jump slightly at a cut. Version 4 (owner
decision 2026-11-17) uses the transcript and the audio together (rule 1): version 3's fixed -40 dB
cut the owner's soft syllables and word endings (-41 to -50 dB) on quieter footage as pauses
(reel dfba7e04: 116.7 s to 48.7 s, and the retimed audio, transcribed again, gave 155 words of 162,
"think", "progress", "can take" gone and "publicly" heard as "public"). With version 4 and the
aligned transcript the same reel is 62.3 s and all 162 words are heard again (the retimed audio
transcribed again: 160 of 162 in order, "lack" heard as "luck" twice); 311f34dd (louder,
pre-cut) is 48.9 s against 48.2 s, 162 words heard (159 in order: "push" heard as "pushed",
"a" as "or", "generation" as "generations"). Version 4 called a gap a pause only where its audio
was silent (under the clip's noise floor plus 20 dB, at most -40 dB). Version 5 (owner decision
2026-11-17) takes the transcript's gaps as the pauses whatever their loudness (rule 1): the owner
records piece by piece, and her pauses are not silent. On reel 40ab0155 (116.7 s, 162 words,
speech about -11 dB, pauses about -31 dB with bursts up to -8 dB, noise floor -46 dB) version 4
found no silence in the pauses: 26 gaps over 0.3 s, 54.8 s in all, were still 49.1 s after
retiming (101.5 s). Whisper run on the three longest pauses alone heard no word. Version 5 gives
56.1 s: no word is cut, one gap over 0.3 s is left (0.67 s, between "to" and "be"), and it holds
the one possible missed word kept (0.40 s of sound at speech level right after "to"). The longest
speech-level burst in any other gap is 0.22 s, under `missedSpeechSeconds`. The check is coarse on
purpose: only 9 of the reel's 36 words of 0.3 s or more hold 0.25 s of frames in a row at that
level, so it holds back a clear, sustained sound, not every word. Version 6 (2026-11-18) fixes two
faults heard in version 5's sound. With every gap a pause, 29 of the short-gap frames of reel
40ab0155 (rule 4) lay on voiced sound, and at `gapRate` each played about 40% lower, a short deep
blip (at 1.42, 3.73, 3.95, 13.24, 13.42 and 15.20 s of the retimed reel, among others): rule 4 now
slows only a quiet frame (`gapQuietBelowSpeechDb`). On the `rethink-work` reference the six
short-gap frames are five at or above the speech level and one 19.9 dB under it; on the two
fixture clips all ten are within 12 dB of it, so none is slowed (the short speech is 2.67 s, was
2.74 s; the ten-second speech 9.52 s, was 9.69 s). And the joins: version 4 cut in silence (the
levels at its joins were -40 to -66 dB), version 5 cuts inside breaths and room sound (106 joins
with median levels of -8.6 to -24.6 dB), where a hard join clicks: every join now has a
`joinFadeSeconds` fade out and fade in (rule 7). The settings and the
version are in the fingerprint, so retime and every step after it re-run for a new upload; a reel
processed before keeps its footage, and Start over (which decides again from version 1, whose
inputs name the old retime outputs) does not re-run retime.

## How to Use

1. Upload footage in the studio; the worker claims the `process` job.
2. Watch the reel page: the status moves through `converting`, `transcribing`, `retiming`,
   `processed`, with a step line each.
3. Retry a failed job: finished steps show `..., reused` and the run resumes at the failed one.
4. After changing a step's behaviour, bump its `version`, then run
   `yarn workspace @edit-issebya/worker fixtures:pipeline` and commit `fixtures/pipeline/`.

## Configuration

- `FFMPEG_PATH` (default `ffmpeg`; `ffprobe` is taken from beside it), `WORKER_SCRATCH_DIR`,
  `R2_KEY_PREFIX` (a malformed value fails the config, naming the variable).
- `HYPERFRAMES_NO_TELEMETRY` is forced to `1` for HyperFrames; the `hyperframes` dependency in
  `apps/worker/package.json` is pinned exactly.
- `yarn workspace @edit-issebya/worker models:fetch`, once per checkout for a native worker, the
  tools tests and `fixtures:pipeline`: fetches the aligner's model (378 MB) into
  `apps/worker/models/` and the re-listen's Whisper `medium` (1.5 GB) into HyperFrames' model
  folder (`~/.cache/hyperframes/whisper/models/`, once per machine). The worker image fetches both
  at build.
- `yarn doctor` in the worker checks that ffmpeg and ffprobe are 7.0 or newer (one line, for
  example `ffmpeg 6.1 found, 7 or newer is needed for HEIC photos (-show_stream_groups)`; a git
  build without a version number passes), and the ffmpeg filters `zscale`, `tonemap`, `atempo`, `astats`,
  `ametadata`, the codecs `libx264` and `libvpx-vp9` (encoders) and the `libvpx-vp9` decoder, and
  that `hyperframes --version` answers. Its `mask tool` line checks the committed MODNet model
  has its pinned size and SHA-256, masks the first second of `fixtures/footage/short-speech.mp4` with the
  real entry and checks the mask is H.264 at the sample's size with 30 frames (give or take one),
  for example `modnet a293b5ae, 1 s masked in 9.4 s`; a missing model fails the line with
  `MODNet model missing at <path>, restore it with git checkout -- apps/worker/models/modnet_int8_13.onnx`.
  Its `aligner` line checks the aligner's model has its pinned size and SHA-256
  (`wav2vec2 e4661427`); a missing one names `models:fetch`. Its `relisten` line checks Whisper
  `medium` the same way (`whisper medium 6c14d5ad`). It checks that `OPENROUTER_API_KEY` is set, fetches the five PostHog prompts by name (no AI call;
  `POSTHOG_PERSONAL_API_KEY`, `app_docs/decide-step.md`, "Prompts"), and makes no AI call; `doctor --ai`
  adds the two paid OpenRouter calls and the image call.
- The MODNet model needs no install: it is the committed `apps/worker/models/modnet_int8_13.onnx`,
  read from there by the `cutout` step and the doctor, natively and in the worker image
  (`app_docs/worker-container.md`). There is no `models:install` and no `WORKER_MODELS_DIR` any more.

## Testing

- `yarn test` (pure, no ffmpeg, HyperFrames, database or network): fingerprints, every settings
  leaf and the version changing the fingerprint, `run-pipeline.test.ts` (hits spawn nothing, a
  missing output re-runs only its step, resume, statuses, clean-up), probe (HDR, VFR), planner on
  synthetic and `testdata/rethink-work/` data (pause cuts and leading and trailing trims only
  inside the transcript's gaps, never inside a word however quiet it is, a long noisy pause with
  short bursts cut to the kept pause, 0.5 s of speech-level sound in a gap kept with the pauses
  around it cut, a quieter sound not kept, overlapping words, a cut at a speed boundary;
  the middle frame of a short pause slowed when quiet and left at its speed when voiced or quiet
  only in part; `pausesLeft` naming the quiet stretch inside a stretched word), `retime.test.ts`
  (the step line with the pauses left and the possible missed words kept), `retime-encode.test.ts`
  (audio and video of every planned piece trimmed at the same frame, a fade out and a fade in at
  every join, no piece's length changed by them), `align.test.ts` (the model's spelling of a
  word, the normalised input, the pieces tiling the clip's frames, the forced alignment on
  synthetic emissions, the times of each word and the fallback for words it cannot spell, the
  decode arguments), `align-model.test.ts` (the pin, the fetch command when the file is missing,
  the notice), `transcribe.test.ts` (the aligner's arguments, its settings and every re-listen setting in the
  fingerprint, the `medium` call), `relisten.test.ts` (the gap rule, the stretched word rule, the
  joining, the window's bounds, the merge between anchors, no anchor and a false alarm changing
  nothing, an old word outside the spot kept, the writing at the join, the ids, the step line), `head-track-step.test.ts` (the sample, count, chunk, join
  and decode calls, the chunks' weighted progress, a failed chunk), `u2net.test.ts` (the model's
  input and mask, the chunks and their threads, the decode and encode arguments),
  `u2net-model.test.ts` (the pin, the file, the notice), and `pipeline-fixtures.test.ts`, which fails when a
  version or setting change leaves either clip's outputs stale (`fixtures/pipeline/` and
  `fixtures/pipeline/speech-ten/`).
- `yarn workspace @edit-issebya/worker test:tools` (`*.tools.test.ts`): real ffmpeg, HyperFrames
  and the aligner (both models fetched once with `models:fetch`) on `fixtures/footage/short-speech.mp4`;
  `transcribe.tools.test.ts` also runs the step on `fixtures/footage/speech-ten.mp4` with a tool
  that takes "alternative" and "ways" out of what Whisper `small` wrote: the aligner stretches
  "to", `medium` hears the window, and the two words come back with times of their own; `head-track.tools.test.ts` runs `head_track` and
  `preview_copies` on `fixtures/footage/short-person.mp4` (the real U2Net entry with the
  committed int8 model, the same track byte for byte in one chunk, in four and by the machine's
  split, at least 80 percent of head samples found, no mask, sample clip or raw frames left, one 540x960 footage preview of the source's duration);
  `cutout/mask-tool.tools.test.ts` runs the real MODNet entry (the installed model, never a
  download) on 3 seconds of `short-person.mp4` (H.264 1080x1920 `yuv420p`, video range BT.709, 90
  frames, 90 progress lines, the face white and a corner black); `render/render.tools.test.ts`
  renders a big word behind the speaker with a real MODNet mask;
  `render/render-compare.tools.test.ts` exports two fixture reels both ways (the single call and
  the composite) and compares them frame by frame and sample by sample (`app_docs/export.md`). The
  owner's Mac only, never CI.
- Unit: `cutout/matte.test.ts` (working size, the model input, the gray matte, the temporal median,
  the frame count and the two ffmpeg calls), `cutout/modnet-model.test.ts` (the model's place, the
  pin, a missing or changed model, the install with a tiny stand-in served by a fake `fetch`, never
  the network), `cutout/mask-tool.test.ts` (the entry's arguments, the missing model line, the
  double), `cutout/spans.test.ts` (every matte setting and the version in the fingerprint).
- `yarn turbo run test:db --filter=./apps/studio`: `pipeline-statuses.test.ts` and the pinned
  `steps` columns (`cache_hit`).
- `apps/studio/e2e/upload.spec.ts` seeds `fixtures/pipeline/` under a per-run key prefix, so every
  step is a hit: five `skipped` rows, reel `processed`, no tool needed in CI.
- `apps/studio/e2e/decide-behind.spec.ts` and the transition test in `apps/studio/e2e/preview.spec.ts`
  seed `speech-ten` (`seedProcessedReel({ clip: "speech-ten" })`), with the scripted answers
  `speechTenVisualAnswerScript` and `speechTenTransitionAnswerScript` (`apps/studio/test-support/ai-script.ts`):
  a VISUAL over w0021 to w0027 and a LIST over w0028 to w0030, both after the hook window (0.2 s to 3 s).
- Manual: run the original `rethink-work` phone file and compare with the old scripts' output
  (format, fps, keyframes, duration, words, segments). The committed reference `retime.json` is
  Draft 02 (1.10 / 1.15); the defaults match Draft 01 (1.05 / 1.1).

## Rules

- No AI in the fixed steps.
- Every step declares everything it reads (inputs, settings, version) and reads nothing else.
- Never overwrite a stored output; uploads are put-if-absent.
- Word ids never change after transcribe; retime keeps them. Transcribe gives them once, by
  position, to the list it writes (after the re-listen). Never renumber a stored transcript, and
  never read a version's words from a transcript other than the one its `inputs` name: an id of
  another transcribe run may be another word.
- Retime never cuts inside a word's span (start to end, the aligner's times) and never removes any
  part of a possible missed word (`missedSpeechSeconds` or more of frames in a row within
  `missedSpeechBelowSpeechDb` of the clip's speech level, inside a gap of the transcript). A pause
  is a gap of the transcript, whatever its loudness. Never decide a pause by a silence level, fixed
  or measured: the audio only holds back a possible missed word.
- Retime never plays voiced sound under 1x: the middle frame of a short pause is slowed to
  `gapRate` only when it is quiet (`gapQuietBelowSpeechDb` under the speech level). Never slow a
  frame without that check.
- Every join of two retimed pieces fades the sound out and in (`joinFadeSeconds`). Never join two
  pieces of sound hard, and never let a fade change a piece's length or touch the video: the
  picture stays frame-exact and the sound stays in step with it.
- Transcribe takes Whisper's words and the aligner's times only. Never add a rule of our own that
  moves a word time; a word the model cannot spell gets the documented fallback, nothing else.
- The re-listen never changes a word outside the two anchors of a spot, never changes anything
  without an anchor on both sides, and never writes a word no Whisper model heard: the only text
  of our own is the full stop and the capital of the join rules. Never loosen the merge to take a
  window's words whole.
- Never fetch Whisper `medium` at job time, and never change its pin in one place only:
  `whisper-model.ts` and the Dockerfile's `model` stage (`WHISPER_MODEL_REVISION` and the SHA-256,
  `dockerfile.test.ts` checks it) change together, and must stay the pin of the installed
  HyperFrames, with a new transcribe fingerprint (`RELISTEN_SETTINGS` names the model).
- Never commit the aligner's model, never fetch it at job time, and never change its pin in one
  place only: `align-model.ts`, the Dockerfile's `aligner` stage (`ALIGN_MODEL_REVISION` and the
  SHA-256, `dockerfile.test.ts` checks it) and the notice change together, with a new transcribe
  fingerprint (`ALIGN_SETTINGS` names the model).
- Never use the float16 export of the aligner's model (`onnx/model_fp16.onnx`): it crashes
  onnxruntime-node on Linux arm64 (the worker container) when the session is created. Never use the
  int8 export either: it misplaces whole words.
- Bump a step's version whenever its behaviour changes, then re-run `fixtures:pipeline`.
- Never report a head top below the mask's first opaque row: `headTopMargin` only raises it, and
  the width band is measured from the real row.
- Never let the head track depend on how its samples are split: no state from one frame to the
  next in the U2Net entry, and one encode over every chunk's masks. Never change the entry's
  preparation of a frame, the mask's encoding or the model without a new `head_track` version.
- Never run HyperFrames through `npx` or `yarn dlx`, and always with `HYPERFRAMES_NO_TELEMETRY=1`.
- Never write to the reference repository (`issebya-homes-reels`).
- Never fingerprint a source without its ETag.
- The cut-out is made on demand, only for the padded spans of `behind` items, by MODNet through
  `onnxruntime-node` (the pinned model, `provider` `cpu`, grayscale H.264, any OS, no fallback
  model), fingerprinted by footage, span, `MATTE_SETTINGS` and `MASK_TOOL_VERSION`, stored
  put-if-absent as `rebuildable` and reused by later versions. `head_track` makes its own
  sampled U2Net mask (the int8 model, its own entry) and never stores it.
- The MODNet model is committed (`apps/worker/models/modnet_int8_13.onnx`), because it is a
  modified file that no official URL serves. Never download it, at install or at job time, never
  run it without checking its pinned size and SHA-256 (`verifyModel`), and never replace it without
  its new pin, a new `MASK_TOOL_VERSION` and an up-to-date `THIRD_PARTY_NOTICES.md` beside it.
  Never commit the calibration footage or frames.
- The U2Net model is committed the same way (`apps/worker/models/u2net_int8_static13.onnx`). Never
  download it, never run it without checking its pinned size and SHA-256 (`verifyU2netModel`), and
  never replace it without its new pin, a new `head_track` version and an up-to-date
  `THIRD_PARTY_NOTICES.md` beside it. Never commit its calibration frames.
- Every output carries a `kept` or `rebuildable` tag.
- The frames sprite always has a tile for the longest footage `FOOTAGE_LIMITS` accepts: never
  raise the limit without its row count following (`preview-copies.test.ts` checks it).
- Never touch `fixtures/footage/short-person.mp4`.

## Notes

- Deleting an earlier step's output re-runs that step only; later steps stay hits because their
  fingerprints are unchanged (re-running would overwrite their outputs). A changed version or
  setting re-runs every step that reads its outputs, directly or through another step (a
  `head_track` change does not re-run `preview_copies`).
- `device: auto` is fingerprinted as a value, not as the provider chosen (CoreML on the Mac, CPU
  elsewhere); outputs from different providers may differ slightly but share a key.
- The short-speech fixtures stay on `short-speech.mp4` (no person): its head track is all `null`,
  enough for cache hits. `fixtures/pipeline/` has no `remove_background/` and no `subject-preview.webm`.
- `fixtures/footage/speech-ten.mp4` is the second committed clip: 10 s, 720x1280, H.264 and AAC, about
  1.5 MB, with a person speaking (its head track finds the face in every sample). It is cut from the
  owner's own 52 s phone clip (not in the repo) from 18.76 s to 28.76 s, the words w0001 to w0036 of
  its own transcript (two sentences, the first spoken from 0 s, the second ending at the clip's end).
  Made by hand, once: transcribe the source with HyperFrames (whisper `small`, language `en`) to pick
  a stretch that starts and ends on sentence boundaries, then cut it with ffmpeg (`scale=720:1280`,
  `libx264` `-crf 26`, `aac` 96k), and keep the file. Its pipeline outputs are made by the same
  `fixtures:pipeline` run as short-speech's, into `fixtures/pipeline/speech-ten/` with a `manifest.json`
  of its own; the short-speech outputs stay byte-identical. Whisper hears the first word of the cut
  as "Media" (the sentence starts with "Social media"), so its transcript differs from the owner's
  words in places; the fixture's words are the pipeline's, not the speech's.
- The ffmpeg build is in no fingerprint: after an ffmpeg upgrade that changes output, bump the
  affected versions by hand.
- Single PUT only: an output above 5 GiB fails. The storage records (`app_docs/storage.md`) did not add multipart for outputs; it is still to come.
- Deviations from the old `retime.py`: slow stretches and short-gap frames are chosen by rule, audio
  pieces are trimmed to their video length instead of measured, `fix_words.py` is out of scope.
- Touches `app_docs/studio.md` (worker, statuses, `skipped`, `cache_hit`, storage) and
  `app_docs/measurement.md` (`runToolsStep`, `recordHit`, the `steps` column set, `receive`
  removed); those two docs still describe the placeholder `receive` step in places.
