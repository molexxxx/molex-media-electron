import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  Tray: vi.fn(),
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() }
}))

const { trayIconFile } = await import('../../src/main/tray')

describe('trayIconFile', () => {
  it('picks the multi-size ICO on Windows, the template glyph on macOS, and the small PNG elsewhere', () => {
    expect(trayIconFile('win32')).toBe('icon.ico')
    expect(trayIconFile('darwin')).toBe('trayTemplate.png')
    expect(trayIconFile('linux')).toBe('tray.png')
    expect(trayIconFile('freebsd')).toBe('tray.png')
  })
})
