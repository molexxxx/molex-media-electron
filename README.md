<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo.svg">
  <img alt="molexMedia" src=".github/assets/logo.svg" width="500">
</picture>

<br/>

**Cross-platform media processing toolkit powered by FFmpeg**

[![CI](https://github.com/tonywied17/molex-media-electron/actions/workflows/ci.yml/badge.svg)](https://github.com/tonywied17/molex-media-electron/actions/workflows/ci.yml)
[![Build](https://github.com/tonywied17/molex-media-electron/actions/workflows/build.yml/badge.svg)](https://github.com/tonywied17/molex-media-electron/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/tonywied17/molex-media-electron?include_prereleases&style=flat-square&color=7c3aed)](https://github.com/tonywied17/molex-media-electron/releases)
[![License](https://img.shields.io/github/license/tonywied17/molex-media-electron?style=flat-square&color=a78bfa)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/tonywied17/molex-media-electron/total?style=flat-square&color=4f46e5)](https://github.com/tonywied17/molex-media-electron/releases)

<br/>

[Download](#install) · [Features](#features) · [Quick Start](#quick-start) · [Contributing](#contributing) · [Report a Bug](https://github.com/tonywied17/molex-media-electron/issues/new?template=bug_report.yml) · [Request a Feature](https://github.com/tonywied17/molex-media-electron/issues/new?template=feature_request.yml)

<br/>

<img alt="Dashboard" src=".github/assets/dashboard.png" width="700" />

</div>

---

## Features

### Batch Audio Processing

- **Loudness Normalization** — ITU-R BS.1770-4 two-pass analysis with configurable Integrated Loudness (LUFS), True Peak (dBFS), and Loudness Range (LU)
- **5 Category Presets** — Defaults, Dialogue, Music, Broadcast, and Cinema — each with tuned I/TP/LRA targets; Advanced mode exposes manual sliders for fine-grained control
- **Volume Boost / Reduce** — Percentage-based amplifier applied to all audio streams; preserves channel layout and sample rate
- **Format Conversion** — Configurable video codec, audio codec, bitrate, resolution, and framerate; stream-copy or full re-encode modes
- **Audio Extraction** — Demux audio from video into MP3, AAC, FLAC, WAV, OGG, Opus, or M4A
- **Video Compression** — CRF-based H.264 with 4 quality presets (lossless / high / medium / low); optional target-size bitrate limiting
- **Concurrent Workers** — Configurable worker pool with mid-batch pause, resume, and cancellation
- **Real-time Progress** — Per-task speed, ETA, and progress bar with desktop notifications on completion
- **35+ Formats** — 21 video extensions (MP4, MKV, AVI, MOV, WebM, TS…) and 14 audio extensions (MP3, WAV, FLAC, OGG, M4A, AAC, Opus…)
- **Subtitle & Metadata Preservation** — Optionally copy subtitle streams, tags, chapters, and metadata to output

### Media Editor

- **Multi-clip Workspace** — Load multiple audio and video clips, each independently probed with format/stream details
- **Trim & Cut** — In/out point editing with two modes: fast (stream-copy, keyframe-aligned) or precise (re-encode, frame-accurate)
- **Merge / Concatenate** — Combine 2+ trimmed segments into a single file via FFmpeg concat demuxer
- **Replace Audio Track (A2)** — Swap a video's audio with another file while preserving the video stream; inline trim handles on the A2 timeline track for trimming the replacement audio in/out points
- **GIF Export** — Two-pass palette generation for high-quality GIFs with configurable loop, FPS (1-30), and width
- **Remux** — Losslessly keep/drop individual streams, edit metadata tags, and set per-stream disposition flags
- **Stream Inspector** — Detailed FFprobe viewer with container info, per-stream codec/resolution/channels/sample rate, and metadata editor
- **Interactive Timeline** — NLE-style timeline with V1, A1, and A2 tracks; draggable scrubber with in/out handles, time markers, and selected-region highlight
- **Playback Controls** — Volume slider, speed selector (0.25x–2x), and keyboard shortcuts (Space, I, O, R)
- **Drag-to-reorder** — Visual multi-clip track lane with proportional clip blocks, audio replacement badges, and drag-and-drop sequencing
- **Video & Waveform Preview** — Native `<video>` for video clips, canvas waveform for audio-only; automatic transcoding for non-browser formats
- **7 Output Formats** — Video: MP4, MKV, WebM, AVI, MOV, TS, GIF — Audio: MP3, WAV, FLAC, OGG, M4A, AAC, Opus

### Media Player

- **Local Playback** — Play audio and video files from your filesystem with full playlist management; seamless large file support (2 GiB+)
- **URL Streaming** — Resolve and stream audio from YouTube videos, playlists, and direct audio URLs via yt-dlp (auto-downloaded)
- **8 Visualizations** — DMT, Space, Milkdrop, Plasma, Bars, Wave, Circular, and Horizon — all real-time canvas rendering via Web Audio API
- **Beat Detection** — Per-frame analysis across sub-bass, bass, low-mid, mid, high-mid, and treble bands with beat-reactive visuals
- **Audio Quality** — Best / Good / Low quality presets for YouTube stream selection
- **Playlist Features** — Drag-to-reorder, shuffle, repeat (off / all / one), now-playing indicator, auto-scroll to active track, folder browser with system shortcuts
- **Transport Bar** — Custom seek bar with visual thumb and fill, play/pause, prev/next, shuffle, repeat, volume slider with mute toggle
- **Popout Player** — Always-on-top window with compact transport, pin/unpin, 3 size presets, custom size memory, state transfer, and auto-resume playback
- **URL Input & History** — Paste YouTube URLs or direct audio links; persisted history with title, track count, and date
- **Cookie Caching** — Transparent browser cookie export for authenticated YouTube content with auto-retry on auth failures

### App & UI

- **Zero Setup** — FFmpeg and yt-dlp are downloaded automatically on first launch
- **Setup Wizard** — First-run flow: Welcome → Downloading → Complete, with retry and manual-install fallback
- **Dashboard** — Quick stats, workflow launchers, tool cards with animated canvas backgrounds, system info, and recent activity feed
- **File Browser** — VLC-style modal with known-folder shortcuts (Music, Videos, Desktop) and multi-file/folder selection
- **System Tray** — Icon with context menu, live batch progress in tooltip, and minimize-to-tray behavior
- **Auto-updater** — Check / download / install from GitHub Releases with progress forwarding and persistent update status from startup
- **Custom Title Bar** — Frameless drag region with logo, version badge, processing indicator, and window controls
- **Collapsible Sidebar** — Dashboard, Batch, Editor, Player, Settings, Logs — auto-collapses on narrow windows with icon-only tooltips
- **Live Processing Panel** — Sidebar-embedded task list with progress bars, pause/cancel controls
- **Log Viewer** — Filterable by level (info / warn / error / success / ffmpeg), free-text search, auto-scroll
- **Drag-and-drop Everywhere** — Drop files onto batch queue, editor, player, or processing view
- **Responsive Design** — Adaptive layouts for sidebar, editor clip list, and timeline
- **Settings** — Audio codec/bitrate/fallback, worker count, output directory, overwrite mode, notifications, tray behavior, browser cookie management, reset to defaults
- **Reset to Defaults** — Each tool (Batch, Editor, Player) has a dedicated reset action that restores all options, state, and UI to factory defaults

---

## Install

Grab the latest release for your platform:

| Platform | Download | Format |
|----------|----------|--------|
| **Windows** | [Latest Release](https://github.com/tonywied17/molex-media-electron/releases/latest) | `.exe` (NSIS installer) |
| **macOS** | [Latest Release](https://github.com/tonywied17/molex-media-electron/releases/latest) | `.dmg` (Intel & Apple Silicon) |
| **Linux** | [Latest Release](https://github.com/tonywied17/molex-media-electron/releases/latest) | `.AppImage` |

> FFmpeg and yt-dlp are downloaded automatically on first launch — no manual setup required.

---

## Quick Start

```bash
# Clone & install
git clone https://github.com/tonywied17/molex-media-electron.git
cd molex-media-electron
npm install

# Development (hot-reload)
npm run dev

# Run tests
npm test

# Build for production
npm run build

# Package for distribution
npm run package          # Current platform
npm run package:win      # Windows
npm run package:mac      # macOS
npm run package:linux    # Linux
```

---

## Tech Stack

- **Electron** — Cross-platform desktop framework
- **React 18** — UI with functional components and hooks
- **TypeScript** — Full type safety across main and renderer
- **Vite** — Build tooling via electron-vite
- **Tailwind CSS** — Utility-first styling
- **Zustand** — Lightweight state management
- **electron-store** — Persistent configuration
- **electron-builder** — Packaging & distribution
- **Vitest** — Unit and integration testing
- **yt-dlp** — YouTube audio streaming and playlist resolution
- **Web Audio API** — Real-time audio analysis and visualization

---

## Feedback & Issues

Found a bug or have an idea? We use GitHub Issue templates to keep things organized:

- [**Report a Bug**](https://github.com/tonywied17/molex-media-electron/issues/new?template=bug_report.yml) — Something isn't working as expected
- [**Request a Feature**](https://github.com/tonywied17/molex-media-electron/issues/new?template=feature_request.yml) — Suggest a new feature or enhancement
- [**Browse Open Issues**](https://github.com/tonywied17/molex-media-electron/issues) — See what's already been reported or upvote existing requests

Please search existing issues before opening a new one to avoid duplicates.

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on branch naming, commit conventions, and the development workflow.

---

## License

[MIT](LICENSE) — build cool things with it.

---

<div align="center">
<sub>Built with Electron · React · Tailwind · FFmpeg</sub>
</div>
