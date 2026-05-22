# Changelog

All notable changes to the audio normalization tool are documented here.

## [4.5.0] — 2026-05-22 — Compress & Extract UI compaction

Aligned the **Compress** and **Extract** operation panels with the
**Convert** panel's compact pattern: a single-row preset selector with a
small curated set of inline "quick" chips plus a categorized **More**
dropdown (powered by the shared `PresetDropdown`), instead of the
multi-row category chip grids that previously dominated the panels
vertically. Extract's quick chips are mode-aware (the visible row swaps
as you switch between Audio / Video / GIF / Frames / Subs). Both panels
now lay out their primary controls in a responsive
`grid-cols-2 sm:grid-cols-3 lg:grid-cols-{4,5}` grid that collapses
cleanly on narrow widths instead of free-flowing `flex-wrap`. No
preset, option, or processor logic changed — purely a UI compaction.

## [4.5.0] — Extract Revamp

A research-driven expansion of the batch **Extract** operation. Where the
previous panel only ripped audio, the revamped tool now exposes five
extraction modes — audio, silent video, animated GIF, still frame
sequences, and embedded subtitles — each backed by a curated preset
library, contextual controls, validation hints, and an optional time-trim
advanced section. Pre-revamp tasks (no `mode` field) still hit the legacy
audio code path verbatim, so all existing workflows and the original
extract test suite continue to pass unchanged.

### Added

#### Five extraction modes
- **Audio** — demux/transcode an audio stream to MP3, AAC, M4A, FLAC,
  WAV, Ogg, or Opus with bitrate / sample-rate / channel overrides
  (existing behaviour, now formalized as one mode of many).
- **Silent video** — strip audio and keep the video track. Defaults to a
  fast lossless stream copy (`-c:v copy`); optionally re-encode to H.264
  with CRF / preset controls for codec normalization.
- **GIF** — render a clip to an optimized animated GIF using FFmpeg's
  recommended two-pass `palettegen` / `paletteuse` pipeline in a single
  invocation (`split` shares the scaled stream between the palette
  generator and the palette consumer). Exposes width, fps, dither
  algorithm (`sierra2_4a`, `bayer`, `floyd_steinberg`, `none`), and loop
  count.
- **Frame sequences** — export still images with four sampling
  strategies: fixed `interval`, target `fps`, evenly-spaced `count` across
  the full duration, or a single midpoint `thumbnail`. PNG / JPG / WebP
  with JPG quality slider. Sequence outputs land in a per-file
  `*_frames/` directory and the completion message reports frame count
  + aggregate size.
- **Subtitles** — pull an embedded subtitle stream to a sidecar `.srt`,
  `.vtt`, or `.ass` file using the appropriate encoder
  (`srt` / `webvtt` / `ass`).

#### Curated preset library (17 presets across 5 categories)
- **Audio** — `audio-mp3-320`, `audio-aac-256`, `audio-opus-128`,
  `audio-flac`, `audio-wav`, `audio-podcast` (mono 64k Opus).
- **Video** — `video-silent-copy` (instant lossless), `video-silent-h264`
  (CRF 20 normalization).
- **GIF** — `gif-hq` (720w / 15 fps / sierra2_4a), `gif-web`
  (480w / 12 fps / sierra2_4a), `gif-social` (360w / 10 fps / bayer).
- **Frames** — `frames-thumb` (single midpoint still),
  `frames-every-sec`, `frames-every-5sec`, `frames-scene-50`.
- **Subtitles** — `subs-srt`, `subs-vtt`, `subs-ass`.

#### UI parity with Convert / Normalize / Boost / Compress
- Full-width `PresetHeader` info bar (preset name, icon, educational
  description) above the controls.
- Category-grouped preset chip rows with per-chip `FixedTip` tooltips so
  users learn what each codec/format does without leaving the panel.
- Mode toggle with per-mode `FixedTip` explanations.
- Validation pills (Lossless copy badge, Re-encoding warning, GIF MB/s
  estimate, Full-duration sampling hint) surface trade-offs before the
  job runs.
- Manual edits clear the active preset and surface a "Custom" amber pill.

#### Advanced controls (collapsible)
- Time-trim section (`-ss` start + `-t` duration, placed *before* `-i`
  for fast keyframe seek) for the video / GIF / frames modes.
- Clear button resets both fields in one click.

#### Per-file overrides
- The inline settings editor and the settings hover card both render
  the full multi-mode summary (preset name, mode label, format,
  per-mode parameters, optional trim line), matching the depth of the
  other operations.

### Changed
- `ExtractOptions` (both in the processor and the renderer store) gained
  optional `mode`, `videoReencode`, `videoCrf`, `gifFps`, `gifWidth`,
  `gifDither`, `gifLoop`, `framesMode`, `frameInterval`, `framesFps`,
  `frameCount`, `frameFormat`, `jpgQuality`, `startTime`, and `duration`
  fields. All optional; omitting `mode` runs the legacy audio path.
- Per-mode stream availability checks: video / GIF / frames modes only
  require a video stream; subtitle mode only requires a subtitle stream;
  the audio mode keeps its existing audio-stream requirement.
- `FileItem` now carries `selectedExtractPreset` and is stamped on
  `addFiles`, on inline edits, and on per-file save just like the other
  operations.

### Tests
- Extended `tests/main/extract.test.ts` from 30 to 44 tests covering
  video stream-copy + re-encode, GIF `palettegen`/`paletteuse` filter
  graph + dither/loop wiring, frames interval/fps/count/thumbnail
  sampling, JPG quality flag, subtitle codec mapping (srt / webvtt),
  no-video / no-subtitle error paths, and time-range placement
  (`-ss` / `-t` before `-i`) for video + GIF.
- Full suite: **946 / 946 passing** (was 932 pre-revamp, +14 new
  extract tests).

## [4.5.0] — Compress Revamp

A complete rebuild of the batch **Compress** operation to match the
research-driven depth of the Convert / Normalize / Boost panels.  The
processor now supports professional encoding workflows (target-size
two-pass, modern AV1, 10-bit color, codec-aware tunes, output scaling)
while remaining backwards compatible with existing tasks.

### Added

#### Curated preset library
- 13 built-in presets organized by category (`BUILTIN_COMPRESS_PRESETS`):
  - **Archive** — Archival (visually lossless x265 CRF 18 slow), HQ
    Master, YouTube Master.
  - **Web** — Web 1080p, Web 720p Compact, Discord (25 MB), Discord
    Nitro (500 MB).
  - **Mobile** — Mobile Friendly (x264 CRF 24 with `fastdecode` tune).
  - **Modern** — AV1 Streaming (libaom-av1 + Opus audio).
  - **Special** — Animation tune, Film Grain preserve (10-bit x265).
  - **Audio** — Lossless FLAC, High AAC 256k.
- Full-width preset info card above the panel (matches other operations).
- Category-labeled chip rows, "Custom" amber pill with reset shortcut.

#### Encoding modes
- **Quality (CRF)** mode with per-codec CRF tables and a new
  **Custom CRF** slider (0–51) for fine-grained tuning.
- **Target Size** mode with a live `≈ Nk video / Nk audio` bitrate
  estimate and an optional **two-pass** toggle for accurate sizing.

#### New options surfaced in the UI
- **Encoder** — H.264, H.265, AV1 (SVT — fast), AV1 (aom — reference), VP9.
- **Max Height** — automatic downscale (`-2:H`) when the source exceeds.
- **Pixel format** — 8-bit (`yuv420p`) or 10-bit (`yuv420p10le`).
- **Tune** (x264/x265) — film / animation / grain / fastdecode / zerolatency.
- **Audio codec** — AAC, Opus, FLAC, or stream copy.
- **Audio bitrate** — 96k – 320k (auto-hidden for FLAC / copy).

#### Validation & education
- Inline pills that explain the impact of each choice:
  - `Use MKV/WebM container` when AV1 / VP9 is selected.
  - `10-bit color` description when yuv420p10le is chosen.
  - `Optimized for old devices` for the `fastdecode` tune.
  - `Grain preserved` for the `grain` tune.
  - `2-pass · ~2× encode time` when two-pass is on.
  - `Low bitrate` amber warning when target size yields < 800 kbps video.
- `FixedTip` descriptions on every chip, button, and select for in-context
  learning ("CRF = Constant Rate Factor", "Two-pass = analyze then encode",
  etc.).

### Changed

- **Processor (`src/main/ffmpeg/processor/compress.ts`)** — full rewrite:
  - New `libsvtav1` branch with `-preset 0–13` mapping.
  - Insertion of `-pix_fmt`, `-tune`, and `-vf scale=-2:H` filter when set.
  - Audio dispatch by codec (`aac` / `libopus` / `flac` / `copy`).
  - Two-pass loop (`-pass 1 -an -f null` → `-pass 2`) for target-size mode,
    with passlog cleanup and proportional progress reporting across passes.
  - `custom` quality tier honoured via `customCrf`.
  - Backwards-compatible mode resolution: legacy callers that only set
    `targetSizeMB > 0` continue to use the bitrate-targeted path.
- **`CompressOptions`** type extended with optional `mode`, `customCrf`,
  `pixelFormat`, `tune`, `maxHeight`, `twoPass`, `audioCodec` fields
  (renderer and main share the same shape).
- **App store** — `selectedCompressPreset` state, setter, stamping in
  `addFiles`, and reset behavior wired in (matches `selectedBoostPreset`
  / `selectedConvertPreset`).
- **Inline per-file settings editor** carries the selected compress
  preset through save / apply-to-all flows.
- **Settings hover card** shows preset name, mode, codec, speed, pixel
  format, tune, max height, audio codec, and two-pass status.

### Tests

- `tests/main/compress.test.ts` — all 35 existing tests pass unchanged
  (backwards compatibility preserved).
- Full suite: **932 / 932** passing across 34 files.

---

## [4.5.0] — Dashboard Pulse & Batch Panel Polish

Follow-up polish across the batch operation panels (Convert / Normalize /
Boost) and a full re-think of the Dashboard's live status panel: real CPU
and GPU utilization sparklines with hover tooltips, robust GPU backend
detection, CPU/GPU model names, and a responsive layout that scrolls
cleanly on narrow widths.

### Added

#### Dashboard "System Pulse"
- **CPU utilization sparkline** — computed in the main process by
  diffing successive `os.cpus()` idle/total snapshots, exposed via
  `system:info.cpuUsage`, sampled every 2 s. Tile shows the CPU model
  name (Ryzen 9 9950X3D etc.), live `XX%` load + core count, and a
  rolling sparkline.
- **GPU utilization sparkline** (NVIDIA only) — new `system:gpuUsage`
  IPC running `nvidia-smi --query-gpu=utilization.gpu` with a 750 ms
  cache, surfaced via `window.api.getGpuUsage`. The tile shows
  `GPU Accel · NN%` alongside the backend label and the detected
  adapter model. Non-NVIDIA systems get `{ usage: null }` and the
  sparkline simply hides.
- **Memory tile** redesigned to match the CPU/GPU card style: header
  with capacity + percent, capacity bar, and a same-sized sparkline at
  the bottom so all three live tiles read as a consistent stack.
- **Hover tooltips on every sparkline.** New reusable `Sparkline`
  component renders the filled area chart plus a vertical guide line,
  a dot at the nearest sample, and a floating mono-font value label
  (`xx.x%`) that follows the cursor and auto-flips at the edges so it
  never clips the panel.
- **CPU model name** in `system:info.cpuModel` (from
  `os.cpus()[0].model`).
- **GPU adapter name** in `system:gpu.gpuModel` — cross-platform helper
  using PowerShell `Get-CimInstance Win32_VideoController` on Windows,
  `lspci` on Linux, and `system_profiler SPDisplaysDataType` on macOS.
  Result cached for the lifetime of the process.

#### Batch operation panels (Convert / Normalize / Boost)
- **Full-width preset description card** lives above the preset chip
  row in all three panels (`PresetHeader` helper in `OperationPanel`).
  The preset name + description are now the visual lead-in to each
  panel rather than buried in a sidebar IIFE, and the modern separator
  underneath cleanly divides "what preset" from "what controls."

### Changed

#### GPU acceleration detection (`ffmpeg/gpu.ts`)
- **Probe the encoder list first.** `detectGpuMode` now reads
  `ffmpeg -encoders` and skips any backend whose codec isn't compiled
  in, eliminating confusing spawn-failures on stripped ffmpeg builds.
- **Bigger synthetic test frame.** Bumped the lavfi source from
  `64x64` to `256x144` (16:9, aligned) so the NVENC minimum-dimension
  constraint can't reject the probe on otherwise-capable NVIDIA
  systems. This was the root cause behind "CPU only" persisting on
  GPUs that perfectly handled real batch encodes.
- **Failure reasons are logged.** Each failed probe now writes the
  first stderr line (or exit code) at info level, so the next time
  detection misfires it's diagnosable from `~/.molexmedia/logs/`
  instead of opaque.
- **Don't cache `'off'` on bootstrap races.** Detection now only
  caches a negative result when at least one probe actually completed;
  spawn errors during early app startup leave the cache empty so the
  next call retries.
- **Detection state is `pending`-aware.** `system:gpu` returns
  `pending: true` until the first real detection completes; the
  renderer re-polls every 3 s until the chip settles.

#### Dashboard layout
- **Workflow strip moved above the hero** so it matches the sidebar
  ordering (Batch first), with the five operation tiles in a
  `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` responsive grid.
- **Stacked Media Editor + Media Player** in the left column of a new
  `lg:grid-cols-[1fr_260px]` hero, with the System Pulse panel
  spanning both rows on the right.
- **Scrolls cleanly on narrow widths.** Root switched from `h-full`
  to `min-h-full`, hero's `flex-1` gated behind `lg:`, and the App
  wrapper now uses asymmetric padding (`pl-* py-* pr-0`) for the
  dashboard view so the scrollbar sits flush against the right
  window border with a small visual gap on the content side.

### Tests
- Full suite: **932 passing** across 34 files.

## [4.5.0] — Convert Revamp

A third-pass overhaul applying the same depth of polish to the **Convert**
tool that was applied to Normalize and Volume Boost: codec/format
awareness throughout the UI, new real-world presets, tooltips on every
control, a lossless/GPU/slow-encode info strip, an advanced section, and
audio-only-aware control hiding so the panel matches the chosen container.

### Added

#### Codec & format metadata (`presets.ts`)
- **Codec classification sets** with predicates: `LOSSLESS_VIDEO_CODECS`
  (copy / ffv1 / utvideo), `LOSSLESS_AUDIO_CODECS` (copy / flac / alac /
  pcm_s16le / pcm_s24le), `GPU_ACCELERATED_VIDEO_CODECS` (libx264 /
  libx265), `SLOW_ENCODE_VIDEO_CODECS` (libaom-av1 / libvpx-vp9).
- **`CODEC_LABELS`** map + `codecLabel()` for friendly names in the info
  strip and preset summary (H.264, H.265, ProRes, FFV1, Opus, etc.).
- **Bitrate parser** (`parseBitrateKbps`) handling `"5000k"`, `"5.5M"`,
  plain numbers, and the `"0"` lossless sentinel. Used by:
- **`estimateOutputSizeMB()`** — duration-based file-size estimate from
  the configured bitrates, suppressed when no bitrate is set or duration
  is unknown.
- **`isAudioOnlyFormat` / `isVideoContainerFormat`** classifiers that
  drive the audio-only branch of the UI.

#### Presets
Five new presets covering real-world distribution scenarios:

- `instagram` (Web) — 1080×1920 vertical 9:16, H.264 / AAC, 3500k video /
  128k audio at 30 fps. Reels / Stories / TikTok upload-ready.
- `email-10mb` (Web) — 854×480 H.264 / AAC at 500k / 96k / 24 fps. Stays
  well under the typical 10 MB attachment cap for clips up to ~2 min.
- `telegram` (Web) — 1080p H.265 / AAC at 4000k / 192k. Compact 4 K-
  capable channel uploads.
- `podcast-mp3` (Audio) — MP3 / libmp3lame at 96k. Low bandwidth speech.
- `audiobook` (Audio) — M4A / AAC at 64k. Tiny long-form spoken-word.

#### UI
- **Two-column responsive layout** matching Normalize and Boost: preset
  chips + info strip + basic controls + advanced controls in the left
  column; preset description card + Advanced toggle in the right column
  on desktop, stacked above on mobile.
- **Preset chip row** with six quick-pick chips (mp4-h264, mkv-hevc,
  webm-vp9, mp3-320, discord, youtube) plus a full categorized
  `PresetDropdown` for the long tail.
- **Custom badge** appears when the active options no longer match any
  preset, so users can see at a glance that they've drifted.
- **Info strip** — live FixedTip badges for active format, video codec,
  audio codec, video bitrate, and audio bitrate; plus an emerald
  **Lossless** badge when both streams use a lossless codec, a non-
  blocking **GPU** hint when libx264 / libx265 is selected, a **Slow
  encode** amber badge for AV1 / VP9, and a red **N conflict** badge
  when `detectConvertConflicts()` reports any issues.
- **FixedTip tooltips** on every control label and help icon: explaining
  containers, codec trade-offs, bitrate units (k vs M), resolution
  preserve-aspect-with-`-1`, framerate constraints, and lossless
  sentinels.
- **Advanced section** (toggleable) — audio bitrate, video bitrate,
  resolution, framerate inputs with educational tooltips on each.
- **Audio-only-aware control hiding** — when the selected container is
  an audio format (mp3 / flac / m4a / etc.), all video controls (Video
  Codec, Video Bitrate, Resolution, Framerate) are hidden so the panel
  only shows the inputs that affect the output.
- **Conflict warnings list** rendered inline under the info strip with
  per-conflict tooltips explaining the fix.

#### Per-file editor parity
- The `Convert` row in `InlineSettingsEditor` now uses the same revamped
  `ConvertConfig` with its own `selectedConvertPreset` state, persisting
  the active preset id back to the file on Save / Apply-to-all.

#### State
- New `selectedConvertPreset: string | null` field on `FileItem` and on
  the batch store (default `'mp4-h264'`). Inherited by newly-added
  files alongside the existing `selectedPreset` (Normalize) and
  `selectedBoostPreset` (Boost). Reset by `resetBatch`.

### Tests

- **`tests/renderer/convert-helpers.test.ts`** (33 cases) — exhaustive
  coverage of `isLosslessCodec` (cross-kind correctness), `isGpuAcceleratable`,
  `isSlowEncodeCodec`, `codecLabel` (every preset codec has a label),
  `parseBitrateKbps` (k / M / plain / sentinel / invalid), and
  `estimateOutputSizeMB` (zero-duration, no-bitrate, audio-only, lossless
  sentinel, numeric bounds) + spot-checks on the five new presets.
- `tests/renderer/presets.test.ts` count expectations updated for the
  expanded WEB_PRESETS (5 → 8) and AUDIO_PRESETS (6 → 8) categories.
- Full suite: **932 passing** across 34 files.

## [4.5.0] — Volume Boost Revamp

A second-pass overhaul applying the same depth of polish to the **Volume
Boost** tool that was applied to Normalize: real-world presets, a proper
advanced section (peak limiter + high-pass filter), a dB-aware info strip,
and — most importantly — a slider that actually responds to drag.

### Added

#### Audio engine
- **Optional peak limiter** (`alimiter`) appended after the gain stage.
  Required for any aggressive boost; keeps true-peak under the configured
  ceiling (-1 dBTP broadcast-safe, -0.3 dBTP loudness max, etc.).
- **Optional high-pass filter** (`highpass`) applied *before* the gain
  stage. Removes sub-audible rumble that would otherwise consume headroom
  and force the limiter to clamp audible signal. Choices: Off / 20 / 60 /
  100 Hz.
- **Filter chain ordering**: `aformat` → optional `highpass` → `volume` →
  optional `alimiter`. Deliberate: HPF before gain preserves headroom;
  limiter after gain catches any peaks created by the boost.

#### Presets
Six boost presets covering the common real-world scenarios:

- `gentle-lift` (General) — +15% with a safety limiter. No tonal change.
- `quiet-rescue` (Voice) — +50% with voice HPF (60 Hz) and brick-wall
  limiter at -1 dBTP. Rescues under-recorded sources.
- `voice-clarity` (Voice) — +30% with an 80 Hz HPF. Best for podcasts,
  interviews, and dialog clips.
- `phone-audio` (Voice) — +75% with a 100 Hz HPF and a tight limiter. For
  phone-recorded clips.
- `maximize` (Music) — +100% (≈+6 dB) into a -0.3 dBTP brick-wall. Loud,
  no clipping.
- `tone-down` (General) — quiets a too-loud source by 25%. No limiter.

#### UI
- **Smooth slider drag.** Removed the 150 ms CSS transitions on the fill
  bar and thumb that were causing visible rubberbanding on every input
  event. The slider now decouples its visual position from store updates
  during a drag (uncontrolled while held, committed on release) so the
  thumb tracks the pointer 1:1 without React re-render lag.
- **dB-aware info strip.** Live readout shows percent, dB equivalent
  (`20·log10(1 + pct/100)`), active limiter ceiling, and active HPF
  cutoff, with tooltips explaining each value.
- **Clip-risk warning.** Inline amber indicator appears when boost is
  positive and the limiter is off; escalates to "High clip risk" past
  +100%.
- **Quick-step buttons** for -50% / -25% / 0% / +25% / +50% / +100% /
  +200% snap targets.
- **Advanced section** (toggle on the right column on desktop, full-width
  bottom on mobile): peak-limiter on/off + ceiling stepper (-6 to 0 dBTP
  in 0.1 dB steps), and HPF segmented control (Off / 20 Hz / 60 Hz /
  100 Hz).
- **Two-column responsive layout** matching the Normalize panel: presets
  + slider + advanced in the left column; preset description card +
  Advanced toggle in the right column on desktop, with the Advanced
  button collapsing full-width to the bottom on mobile (`flex-col-reverse
  md:flex-col`).
- **Preset description card** explains the intent of the active preset
  inline, same idiom as the normalize panel.

### Changed
- `BoostOptions` now carries `{ percent, limiter, limiterCeiling, hpfHz }`
  end-to-end (renderer store → IPC spec → main-process `ProcessingTask` →
  `boost.ts` filter assembly). The legacy `boostPercent` field is kept on
  `ProcessingTask` for backward compatibility; `boostOptions` is purely
  additive.
- `InlineSettingsEditor` mirrors the new boost UI for per-file overrides.

## [4.5.0] — Normalization Revamp

A focused overhaul of the batch normalization workflow: smarter presets aimed
at real-world problems (home-theatre loudness imbalance, dialog clarity on TV
speakers), a new dynamic-range-compression stage, channel-layout controls,
and a cleaner two-column configuration UI with proper tooltips throughout.

### Added

#### Audio engine
- **Dynamic range compression stage** (`acompressor`) applied *after*
  `loudnorm`, with four discrete strengths:
  - `off` — bypass.
  - `light` — 2:1 above -22 dB, +2 dB makeup. Mostly transparent.
  - `medium` — 3:1 above -24 dB, +3 dB makeup. Tames bass-heavy action.
  - `heavy` — 6:1 above -26 dB, +5 dB makeup, fast attack. Whispers stay audible.
- **True-peak re-limit** (`alimiter`) is appended automatically when DRC is
  on, so makeup gain cannot violate the configured TP ceiling.
- **Channel-layout strategies** via a `pan` filter built per source:
  - `keep` — preserve original layout (5.1 / 7.1 untouched).
  - `stereo` — plain stereo downmix.
  - `dialog-stereo` — 5.1+ → stereo with center channel boosted ~+3 dB and
    surrounds attenuated ~-6 dB; designed to recover mumbled dialog on
    laptops and TV speakers. Falls back to plain stereo on non-5.1 sources.
- **Filter chain ordering** is now: optional downmix → `loudnorm` (linear
  mode with pass-1 measurements) → optional `acompressor` → `alimiter`.
  The order is deliberate: downmix first so loudness is measured against the
  final layout; DRC last so makeup gain doesn't shift the LUFS target.

#### Presets
A new preset library replaces the previous five-entry set. The "Movies"
group specifically targets the home-theatre loudness-imbalance problem:

- `defaults` (General) — global settings; DRC off, layout kept.
- `movie-balance` (Movies) — -18 LUFS, LRA 9, medium DRC, keep layout. Tames loud action.
- `movie-dialog` (Movies) — -16 LUFS, LRA 7, medium DRC, dialog-stereo downmix.
- `movie-latenight` (Movies) — -15 LUFS, LRA 5, heavy DRC, dialog-stereo. Whispers audible, explosions tamed.
- `podcast` (Speech) — -16 LUFS, LRA 8, light DRC. Replaces the old `dialogue`.
- `music-streaming` (Music) — -14 LUFS, LRA 11, no DRC. Streaming platforms (Spotify / YouTube target).
- `music-album` (Music) — -18 LUFS, LRA 14, no DRC. Audiophile album target.
- `broadcast` (Broadcast) — -23 LUFS, LRA 15. EBU R128 / ATSC A/85.

Each preset now carries an optional `category` field used to group / label
chips in the UI.

#### UI — Operation panel (global) and inline editor (per file)
- **Two-column normalize config layout**: left column hosts preset chips,
  the live info strip, the segmented controls, and the advanced sliders;
  right column hosts the Advanced toggle (right-aligned) with the selected
  preset's description card stacked beneath it.
- **Segmented controls** for Dynamic compression (Off / Light / Medium / Heavy)
  and Channel layout (Keep / Stereo / Dialog stereo), each with its own
  label and per-option tooltip.
- **Live info strip** above the controls — monospace badges for current
  `I`, `TP`, `LRA`, plus `DRC:<level>` and the active downmix mode when
  either differs from defaults, and the resolved codec / bitrate of the
  selected preset.
- **Custom indicator chip** with an inline clear-back-to-defaults button
  appears whenever settings diverge from any built-in preset.
- **Advanced toggle** reveals fine-grained Loudness (LUFS) and LRA sliders
  plus a discrete True Peak stepper.
- **True Peak stepper** replaces the old slider: ± buttons in 0.5 dB steps
  with a clipping-risk warning that appears above -1 dBTP and explains the
  inter-sample clipping risk on lossy re-encodes.
- **Portal-rendered tooltips** (`FixedTip`) replace native `title=` tooltips
  for all info badges, control labels, segmented-control options, and the
  clipping-risk warning. Tooltips escape overflow containers (z-9999) and
  size to their content (up to 18rem) instead of being squeezed to trigger
  width.
- **Settings hover card** now surfaces the active compression level and
  downmix mode alongside `I` / `TP` / `LRA` when normalizing.

### Changed
- `NormalizeOptions` extended with optional `compression` and `downmix`
  fields. Files / configs that omit them default to the previous behaviour
  (DRC off, layout kept).
- `ProcessingTask.normalizeOptions` carries `compression` and `downmix` end
  to end so per-file overrides and presets reach the FFmpeg builder intact.
- Inline (per-queue-item) settings editor now mirrors the global panel:
  same preset chips, same info strip, same segmented controls, same
  tooltip system. Advanced sliders are always visible inline.
- Drag-to-reorder is now triggered only by the row's drag handle, not the
  entire row — so dragging a slider thumb no longer accidentally reorders
  the queue.
- Slider component restored: a fully visible thumb overlay sits on top of
  the (now invisible) native `<input type="range">` so dragging works
  reliably and the thumb is always shown.

### Removed
- **`cinema` preset** — its previous configuration (-24 LUFS, LRA 20)
  *increased* perceived dynamic range, which is the opposite of what users
  actually wanted for movie playback. Superseded by the three `movie-*`
  rescue presets above.
- **`dialogue` / `music` presets** — renamed to `podcast` and
  `music-streaming` respectively, with DRC and category metadata added.
- **Preset-chip tooltips** — removed; the selected preset's description is
  now shown once, prominently, in the right-column description card.
- **Native `title=` tooltips** on info badges and control labels — replaced
  by the portal-rendered `FixedTip` component.

### Fixed
- Sliders inside the queue-item dropdown no longer fail to respond to drag
  input (root cause: HTML5 drag-to-reorder was capturing pointer events on
  the entire row).
- Tooltip content that exceeded the trigger's width is no longer collapsed
  into a one-word-per-line column (root cause: a Tailwind `max-w-[16rem]`
  class with no explicit width meant the tooltip inherited the trigger's
  flex width; replaced with inline `width: max-content` + `maxWidth: 18rem`).
- The Advanced toggle button now reads as a button when inactive
  (subtle bordered styling) instead of looking like inert text.

### Files touched
- `src/main/ffmpeg/processor/normalize.ts` — new `buildCompressorFilter` /
  `buildDownmixFilter` helpers; filter-chain assembly rewritten.
- `src/main/ffmpeg/processor/types.ts` — `ProcessingTask.normalizeOptions`
  gains `compression` / `downmix`.
- `src/renderer/src/stores/types.ts` — `NormalizeOptions`, `Preset`, and
  `BUILTIN_PRESETS` updated; `CompressionLevel` and `DownmixMode` added.
- `src/renderer/src/components/batch/components/OperationPanel.tsx` —
  new two-column normalize config layout, segmented controls, info strip,
  TP stepper, portal tooltips.
- `src/renderer/src/components/batch/components/InlineSettingsEditor.tsx` —
  per-file editor synced with the new global layout.
- `src/renderer/src/components/batch/components/SettingsHoverCard.tsx` —
  surfaces compression / downmix when set.
- `src/renderer/src/components/batch/components/QueueList.tsx` —
  drag-handle-only reordering.
- `src/renderer/src/components/shared/ui.tsx` — `FixedTip` gains `wide` and
  `inline` props; portal sizing fixed.

### Validation
- All 859 unit tests in 30 vitest files pass. The `loudnorm` filter string
  signature is intentionally unchanged so `tests/main/normalize.test.ts`
  remains green; DRC and downmix are appended as additional chain links
  rather than altering the existing loudnorm invocation.
