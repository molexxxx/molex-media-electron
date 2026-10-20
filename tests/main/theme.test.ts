/**
 * Window paint color. Main cannot read the renderer's CSS, so GROUND_HEX duplicates `--color-ground`; a
 * mismatch would flash a different color behind the first renderer frame of every window.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUND_HEX } from '../../src/main/theme'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function read(file: string): string
{
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
}

describe('main theme', () =>
{
  it('exports the ground as a six-digit hex color', () =>
  {
    expect(GROUND_HEX).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('matches --color-ground in tokens.css', () =>
  {
    const ground = /--color-ground\s*:\s*(#[0-9a-fA-F]{6})\s*;/.exec(read('src/renderer/src/styles/tokens.css'))
    expect(ground?.[1]).toBe(GROUND_HEX)
  })

  it('paints every window, the main window and the popout included, with it', () =>
  {
    const windows = read('src/main/windows.ts')
    const paints = windows.match(/backgroundColor:/g) ?? []
    expect(paints.length).toBeGreaterThanOrEqual(2)
    expect(windows.match(/backgroundColor:\s*GROUND_HEX\b/g)).toHaveLength(paints.length)
  })
})
