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
    hookTimeout: 900_000
  }
})
