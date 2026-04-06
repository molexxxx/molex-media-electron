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

[Download](#install) · [Features](#features) · [Quick Start](#quick-start) · [Contributing](CONTRIBUTING.md)

<br/>

</div>

---

## Features

<table>
<tr>
<td width="50%">

**Batch Audio Processing**
- ITU-R BS.1770-4 two-pass loudness normalization
- Target LUFS, True Peak, and Loudness Range controls
- Percentage-based volume boost / reduce
- Format conversion with codec inheritance & smart fallback
- Audio extraction from video files
- Video compression with configurable quality
- Subtitle and metadata stream preservation
- 17+ format support (MP4, MKV, AVI, MOV, MP3, WAV, FLAC, OGG, M4A, AAC…)
- Built-in file browser with quick-access locations
- Add dropdown menu (File Browser, Choose Files, Add Folder)

</td>
<td width="50%">

**Performance & Workflow**
- Concurrent batch processing with configurable worker count
- Real-time progress tracking with speed & ETA per task
- Drag-and-drop file queueing
- Desktop notifications on batch completion
- Collapsible sidebar with CSS tooltips in icon-only mode
- Minimize to system tray
- Auto-save settings with instant apply
- Overwrite original or save alongside

</td>
</tr>
<tr>
<td width="50%">

**Media Editor**
- Precision timeline with draggable in/out points
- Cut and trim audio & video clips
- Merge multiple clips into one file
- Stream inspector with per-stream toggle, metadata editing, and disposition flags
- Remux without re-encoding

</td>
<td width="50%">

**Media Player**
- Local file playback and playlist management
- YouTube streaming via yt-dlp (auto-downloaded)
- YouTube playlist resolution and queueing
- Shuffle, repeat (one / all), and drag-to-reorder
- 8 real-time audio visualizations: Bars, Waveform, Radial, Spectrum, Space, DMT, Milkdrop, and Plasma
- Unique per-mode visualization icons and tooltip controls
- Beat detection and loudness-reactive visuals
- Popout player window with compact transport
- Playlist overlay with click-outside dismiss
- Add dropdown menu (File Browser, Choose Files, External Link)
- Responsive compact transport bar and icon-only header
- Smart cookie caching for authenticated YouTube content

</td>
</tr>
</table>

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

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

[MIT](LICENSE) — build cool things with it.

---

<div align="center">
<sub>Built with Electron · React · Tailwind · FFmpeg</sub>
</div>
