<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo.svg">
  <img alt="molexAudio" src=".github/assets/logo.svg" width="500">
</picture>

<br/>

**Cross-platform audio normalization & processing powered by FFmpeg**

[![CI](https://github.com/tonywied17/molex-audio-electron/actions/workflows/ci.yml/badge.svg)](https://github.com/tonywied17/molex-audio-electron/actions/workflows/ci.yml)
[![Build](https://github.com/tonywied17/molex-audio-electron/actions/workflows/build.yml/badge.svg)](https://github.com/tonywied17/molex-audio-electron/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/tonywied17/molex-audio-electron?include_prereleases&style=flat-square&color=7c3aed)](https://github.com/tonywied17/molex-audio-electron/releases)
[![License](https://img.shields.io/github/license/tonywied17/molex-audio-electron?style=flat-square&color=a78bfa)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/tonywied17/molex-audio-electron/total?style=flat-square&color=4f46e5)](https://github.com/tonywied17/molex-audio-electron/releases)

<br/>

[Download](#-install) · [Features](#-features) · [Quick Start](#-quick-start) · [Contributing](CONTRIBUTING.md)

<br/>

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

**🎚️ Audio Processing**
- ITU-R BS.1770-4 loudness normalization
- Target LUFS, True Peak, and Loudness Range
- Precise percentage-based volume boosting
- Per-stream codec inheritance with smart fallback
- Subtitle stream preservation

</td>
<td width="50%">

**⚡ Performance**
- Concurrent batch processing with configurable workers
- Real-time progress with speed & ETA
- 17+ format support (MP4, MKV, AVI, MOV, MP3, WAV, FLAC, OGG, M4A, AAC…)

</td>
</tr>
<tr>
<td width="50%">

**🖥️ Modern UI**
- Dark theme with glassmorphism
- Smooth Framer Motion animations
- Drag-and-drop file queue
- Filterable log viewer with FFmpeg debug output

</td>
<td width="50%">

**🔧 Developer Experience**
- Auto FFmpeg download & setup wizard
- Cross-platform builds (Windows, macOS, Linux)
- Typed IPC with context isolation
- Zustand state management

</td>
</tr>
</table>

---

## 📥 Install

Grab the latest release for your platform:

| Platform | Download | Format |
|----------|----------|--------|
| **Windows** | [Latest Release](https://github.com/molex/molex-audio-electron/releases/latest) | `.exe` (NSIS installer) |
| **macOS** | [Latest Release](https://github.com/molex/molex-audio-electron/releases/latest) | `.dmg` (Intel & Apple Silicon) |
| **Linux** | [Latest Release](https://github.com/molex/molex-audio-electron/releases/latest) | `.AppImage` |

> FFmpeg is downloaded automatically on first launch — no manual setup required.

---

## 🚀 Quick Start

```bash
# Clone & install
git clone https://github.com/tonywied17/molex-audio-electron.git
cd molex-audio-electron
npm install

# Development (hot-reload)
npm run dev

# Build for production
npm run build

# Package for distribution
npm run package          # Current platform
npm run package:win      # Windows
npm run package:mac      # macOS
npm run package:linux    # Linux
```

---

## 🏗️ Architecture

```
src/
├── main/                   # Electron main process
│   ├── index.ts            # Window creation & app lifecycle
│   ├── ipc.ts              # IPC handler registration
│   ├── config.ts           # Persistent config (electron-store)
│   ├── logger.ts           # Dual-output logging
│   └── ffmpeg/
│       ├── bootstrap.ts    # FFmpeg download & setup wizard
│       ├── probe.ts        # ffprobe wrapper with fallbacks
│       ├── processor.ts    # Normalize / boost / batch engine
│       └── runner.ts       # Process execution & management
├── preload/
│   └── index.ts            # Context bridge (typed IPC API)
└── renderer/               # React + Vite + Tailwind
    └── src/
        ├── App.tsx
        ├── stores/         # Zustand state management
        ├── hooks/          # IPC event subscriptions
        └── components/     # UI components
```

---

## ⚙️ Configuration

Settings are persisted via `electron-store`:

| Setting | Default | Description |
|---------|---------|-------------|
| I (LUFS) | `-16.0` | Integrated loudness target |
| TP (dBFS) | `-1.5` | True peak maximum |
| LRA (LU) | `11.0` | Loudness range |
| Audio Codec | `inherit` | Codec strategy per stream |
| Bitrate | `256k` | Audio encoding bitrate |
| Max Workers | CPU count | Concurrent processing limit |

---

## 🔄 Release Process

This project uses automated releases:

1. Write code using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, etc.)
2. Tag a release: `git tag v3.1.0 && git push --tags`
3. GitHub Actions builds all platforms and creates a release with auto-generated patch notes

Pre-release tags (`v3.1.0-beta.1`, `-alpha`, `-rc`) are marked as pre-releases automatically.

---

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

[MIT](LICENSE) — build cool things with it.

---

<div align="center">
<sub>Built with Electron · React · Tailwind · FFmpeg</sub>
</div>

## Tech Stack

- **Electron** — Cross-platform desktop framework
- **React 18** — UI library
- **TypeScript** — Type safety
- **Vite** — Build tooling (via electron-vite)
- **Tailwind CSS** — Utility-first styling
- **Zustand** — Lightweight state management
- **electron-store** — Persistent configuration
- **electron-builder** — Packaging & distribution

## License

MIT
