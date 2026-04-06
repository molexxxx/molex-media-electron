import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/main/**/*.ts',
        'src/renderer/src/stores/**/*.ts'
      ],
      exclude: [
        'src/main/index.ts',
        'src/main/ipc.ts',
        'src/main/protocol.ts',
        'src/main/tray.ts',
        'src/main/windows.ts',
        'src/main/ipc/**',
        'src/main/ffmpeg/processor/index.ts',
        'src/main/ffmpeg/bootstrap.ts',
        'src/main/updater.ts',
        'src/main/ytdlp/index.ts',
        'src/main/ytdlp/binary.ts',
        'src/preload/**',
        '**/*.d.ts'
      ],
      thresholds: {
        statements: 90,
        functions: 85,
        lines: 90,
        branches: 75
      }
    },
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/main/**/*.test.ts'],
          setupFiles: ['tests/main/setup.ts']
        }
      },
      {
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
          setupFiles: ['tests/renderer/setup.ts'],
          alias: {
            '@renderer': path.resolve(__dirname, 'src/renderer/src')
          }
        }
      }
    ]
  }
})
