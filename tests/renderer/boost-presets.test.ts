/**
 * Vet the renderer-side preset libraries for the revamped Boost and
 * Normalize tools. Confirms preset IDs are unique, all required fields
 * are present, and the preset numeric values are sane (e.g. boost
 * percent in the allowed slider range, limiter ceiling at or below 0
 * dBTP).
 */

import { describe, it, expect } from 'vitest'
import { BUILTIN_BOOST_PRESETS, BUILTIN_PRESETS } from '../../src/renderer/src/stores/types'

describe('BUILTIN_BOOST_PRESETS', () => {
  it('has unique IDs', () => {
    const ids = BUILTIN_BOOST_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every preset has id/name/description/category/options', () => {
    for (const p of BUILTIN_BOOST_PRESETS) {
      expect(p.id).toBeTruthy()
      expect(p.name).toBeTruthy()
      expect(p.description).toBeTruthy()
      expect(['Voice', 'Music', 'General']).toContain(p.category)
      expect(p.options).toBeDefined()
      expect(typeof p.options.percent).toBe('number')
    }
  })

  it('percent stays within the slider range (-50..+200)', () => {
    for (const p of BUILTIN_BOOST_PRESETS) {
      expect(p.options.percent).toBeGreaterThanOrEqual(-50)
      expect(p.options.percent).toBeLessThanOrEqual(200)
    }
  })

  it('limiter ceiling, when set, is ≤ 0 dBTP and ≥ -6 dBTP', () => {
    for (const p of BUILTIN_BOOST_PRESETS) {
      if (p.options.limiter) {
        expect(p.options.limiterCeiling).toBeLessThanOrEqual(0)
        expect(p.options.limiterCeiling).toBeGreaterThanOrEqual(-6)
      }
    }
  })

  it('HPF cutoff is 0 or a sensible voice/music value (≤ 200 Hz)', () => {
    for (const p of BUILTIN_BOOST_PRESETS) {
      expect(p.options.hpfHz).toBeGreaterThanOrEqual(0)
      expect(p.options.hpfHz).toBeLessThanOrEqual(200)
    }
  })

  it('any preset with positive gain >= 50% enables the limiter (safety)', () => {
    for (const p of BUILTIN_BOOST_PRESETS) {
      if (p.options.percent >= 50) {
        expect(p.options.limiter, `preset ${p.id} boosts ${p.options.percent}% without a limiter`).toBe(true)
      }
    }
  })

  it('voice presets apply a high-pass filter (rumble removal)', () => {
    for (const p of BUILTIN_BOOST_PRESETS) {
      if (p.category === 'Voice') {
        expect(p.options.hpfHz, `voice preset ${p.id} has no HPF`).toBeGreaterThan(0)
      }
    }
  })

  it('includes the canonical preset set', () => {
    const ids = BUILTIN_BOOST_PRESETS.map((p) => p.id)
    for (const expected of ['gentle-lift', 'quiet-rescue', 'voice-clarity', 'phone-audio', 'maximize', 'tone-down']) {
      expect(ids).toContain(expected)
    }
  })

  it('maximize preset is aggressive: +100% with a tight ceiling', () => {
    const p = BUILTIN_BOOST_PRESETS.find((x) => x.id === 'maximize')!
    expect(p.options.percent).toBe(100)
    expect(p.options.limiter).toBe(true)
    expect(p.options.limiterCeiling).toBeLessThanOrEqual(-0.1)
  })

  it('tone-down preset is a reduction with no limiter', () => {
    const p = BUILTIN_BOOST_PRESETS.find((x) => x.id === 'tone-down')!
    expect(p.options.percent).toBeLessThan(0)
    expect(p.options.limiter).toBe(false)
  })
})

describe('BUILTIN_PRESETS (normalize)', () => {
  it('has unique IDs', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every preset carries an I/TP/LRA triple', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.normalization).toBeDefined()
      expect(typeof p.normalization.I).toBe('number')
      expect(typeof p.normalization.TP).toBe('number')
      expect(typeof p.normalization.LRA).toBe('number')
    }
  })

  it('all I targets are negative (LUFS is a negative loudness measurement)', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.normalization.I).toBeLessThan(0)
    }
  })

  it('all TP ceilings are at most 0 dBTP', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.normalization.TP).toBeLessThanOrEqual(0)
    }
  })

  it('all LRA values are positive (loudness range cannot be negative)', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.normalization.LRA).toBeGreaterThan(0)
    }
  })
})
