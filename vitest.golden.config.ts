import { defineConfig } from 'vitest/config'

/** The golden suite on a real FFmpeg build; never part of `npm test` or coverage. */
export default defineConfig({
  test: {
    name: 'golden',
    environment: 'node',
    include: ['tests/golden/**/*.golden.ts'],
    setupFiles: ['tests/main/setup.ts'],
    globalSetup: ['tests/golden/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 180_000,
    // A file's setup hook runs every case of the file on the runner; Intel macOS runners have needed past 15 minutes.
    hookTimeout: 1_800_000
  }
})
