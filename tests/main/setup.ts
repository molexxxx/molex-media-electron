import { vi } from 'vitest'

// Mock electron module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-app'),
    getName: vi.fn(() => 'molex-media'),
    getVersion: vi.fn(() => '3.0.0')
  }
}))

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn(),
      set: vi.fn(),
      store: {}
    }))
  }
})
