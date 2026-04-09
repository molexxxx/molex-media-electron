# Contributing to molexMedia

## Getting Started

### Prerequisites

- **Node.js** 20+
- **npm** 10+
- **Git**

### Setup

```bash
git clone https://github.com/molex/molex-media-electron.git
cd molex-media-electron
npm install
npm run dev
```

The app will launch with hot-reload enabled. Changes to renderer code reflect instantly; main process changes trigger an automatic restart.

## Development Workflow

### Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/short-description` | `feat/batch-presets` |
| Bug fix | `fix/short-description` | `fix/codec-fallback` |
| Docs | `docs/short-description` | `docs/api-reference` |
| Refactor | `refactor/short-description` | `refactor/ipc-handlers` |

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/) so changelogs generate automatically.

```
feat(processor): add AAC codec support
fix(probe): handle streams with missing duration
docs: update build instructions for macOS
chore(deps): bump electron to v32
```

**Types:** `feat`, `fix`, `perf`, `refactor`, `style`, `docs`, `test`, `chore`, `ci`

**Scopes (optional):** `processor`, `probe`, `bootstrap`, `runner`, `ui`, `settings`, `ipc`, `config`, `deps`

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes with clear, focused commits
3. Ensure `npm run build` succeeds
4. Open a PR using the template - describe what and why
5. Link any related issues

## Project Structure

```
src/
├── main/           # Electron main process (Node.js)
│   └── ffmpeg/     # FFmpeg integration layer
├── preload/        # Context bridge (security boundary)
└── renderer/       # React UI (Vite + Tailwind)
    └── src/
        ├── components/   # React components
        ├── hooks/        # Custom hooks
        └── stores/       # Zustand state
```

| Directory | Language | Notes |
|-----------|----------|-------|
| `main/` | TypeScript (Node) | Runs in Electron's main process |
| `preload/` | TypeScript (Node) | Sandboxed bridge between main ↔ renderer |
| `renderer/` | TypeScript (React) | Runs in Chromium |

## Building

```bash
npm run build          # Compile TypeScript + Vite
npm run package        # Build for current platform
npm run package:win    # Windows (.exe)
npm run package:mac    # macOS (.dmg)
npm run package:linux  # Linux (.AppImage)
```

## Code Style

- TypeScript strict mode is enabled
- Use functional React components with hooks
- State management via Zustand - keep stores minimal
- Tailwind CSS for styling - avoid inline styles

## Reporting Bugs

Use the [Bug Report template](https://github.com/molex/molex-media-electron/issues/new?template=bug_report.yml). Include:

- OS and version
- App version
- Steps to reproduce
- Log output (from the Log Viewer)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
