/**
 * Regression tests for the settings a queued file is processed with.
 *
 * The reported "audio boost does not apply" fault lived here, not in the
 * FFmpeg layer: files were stamped with the operation panel's settings at
 * the moment they were added and dispatched with that snapshot, so any
 * change made afterwards - moving the boost slider, switching operation,
 * picking a preset - never reached the main process. A user who added
 * files and then asked for +100 % got the +10 % default instead, which is
 * a 0.83 dB change and effectively inaudible.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  resolveFileSettings,
  buildTaskSpec,
  isCustomized,
  type GlobalOperationSettings
} from '../../src/renderer/src/stores/taskSettings'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import type { FileItem } from '../../src/renderer/src/stores/types'

const globals = (over: Partial<GlobalOperationSettings> = {}): GlobalOperationSettings => ({
  operation: 'boost',
  boostPercent: 100,
  boostOptions: { percent: 100, limiter: true, limiterCeiling: -1, hpfHz: 0 },
  normalizeOptions: { I: -16, TP: -1.5, LRA: 11 },
  convertOptions: {
    outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac',
    videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: ''
  },
  extractOptions: { mode: 'audio', outputFormat: 'mp3', streamIndex: 0, audioBitrate: '320k', sampleRate: '', channels: '' },
  compressOptions: { mode: 'crf', targetSizeMB: 0, quality: 'medium', customCrf: 23 },
  selectedPreset: 'defaults',
  selectedBoostPreset: 'maximize',
  ...over
})

const file = (over: Partial<FileItem> = {}): FileItem => ({
  path: 'C:/media/movie.mkv',
  name: 'movie.mkv',
  size: 1024,
  ext: '.mkv',
  ...over
})

/* ------------------------------------------------------------------ */
/*  Resolution                                                         */
/* ------------------------------------------------------------------ */

describe('resolveFileSettings', () => {
  it('follows the live panel for a file that was never edited', () => {
    // The exact reported bug: the file was stamped at +10 % when it was
    // added, the user then dragged the slider to +100 %.
    const stale = file({ operation: 'boost', boostPercent: 10, boostOptions: { percent: 10, limiter: true, limiterCeiling: -1, hpfHz: 0 } })
    const resolved = resolveFileSettings(stale, globals())
    expect(resolved.boostPercent).toBe(100)
    expect(resolved.boostOptions.percent).toBe(100)
  })

  it('follows the live panel for the operation itself', () => {
    // Files added while the panel said "convert" must not silently convert
    // after the user switches the panel to "boost".
    const stale = file({ operation: 'convert' })
    expect(resolveFileSettings(stale, globals({ operation: 'boost' })).operation).toBe('boost')
  })

  it('follows the live panel across every operation\'s options', () => {
    const stale = file({
      operation: 'convert',
      normalizeOptions: { I: -24, TP: -2, LRA: 7 },
      convertOptions: { outputFormat: 'avi', videoCodec: 'copy', audioCodec: 'copy', videoBitrate: '', audioBitrate: '', resolution: '', framerate: '' },
      compressOptions: { mode: 'crf', targetSizeMB: 0, quality: 'low' },
      extractOptions: { mode: 'audio', outputFormat: 'wav', streamIndex: 3 }
    })
    const resolved = resolveFileSettings(stale, globals())
    expect(resolved.normalizeOptions.I).toBe(-16)
    expect(resolved.convertOptions.outputFormat).toBe('mp4')
    expect(resolved.compressOptions.quality).toBe('medium')
    expect(resolved.extractOptions.outputFormat).toBe('mp3')
    expect(resolved.selectedBoostPreset).toBe('maximize')
  })

  it('keeps a customized file\'s own settings', () => {
    // Per-file overrides are a deliberate feature; the panel must not
    // stomp on a file the user edited individually.
    const edited = file({ customized: true, operation: 'boost', boostPercent: 25, boostOptions: { percent: 25, limiter: false, limiterCeiling: -3, hpfHz: 80 } })
    const resolved = resolveFileSettings(edited, globals())
    expect(resolved.boostPercent).toBe(25)
    expect(resolved.boostOptions.percent).toBe(25)
    expect(resolved.boostOptions.hpfHz).toBe(80)
    expect(resolved.boostOptions.limiter).toBe(false)
  })

  it('lets a customized file keep a different operation from the panel', () => {
    const edited = file({ customized: true, operation: 'normalize' })
    expect(resolveFileSettings(edited, globals({ operation: 'boost' })).operation).toBe('normalize')
  })

  it('fills gaps in a customized file from the panel', () => {
    // A file pinned while editing "boost" carries no compress options; it
    // should still resolve to something valid rather than undefined.
    const edited = file({ customized: true, operation: 'boost', boostPercent: 25 })
    const resolved = resolveFileSettings(edited, globals())
    expect(resolved.compressOptions).toEqual(globals().compressOptions)
    expect(resolved.normalizeOptions).toEqual(globals().normalizeOptions)
  })

  it('treats boostPercent 0 as a real value, not a missing one', () => {
    const edited = file({ customized: true, operation: 'boost', boostPercent: 0 })
    expect(resolveFileSettings(edited, globals()).boostPercent).toBe(0)
  })

  it('treats a negative boost as a real value', () => {
    const edited = file({ customized: true, operation: 'boost', boostPercent: -40 })
    expect(resolveFileSettings(edited, globals()).boostPercent).toBe(-40)
  })

  it('normalizes absent preset ids to null', () => {
    const resolved = resolveFileSettings(file(), globals({ selectedPreset: undefined, selectedBoostPreset: undefined }))
    expect(resolved.selectedPreset).toBeNull()
    expect(resolved.selectedBoostPreset).toBeNull()
  })
})

describe('isCustomized', () => {
  it('is false until the file is edited', () => {
    expect(isCustomized(file())).toBe(false)
    expect(isCustomized(file({ customized: false }))).toBe(false)
    expect(isCustomized(file({ boostPercent: 10 }))).toBe(false)
  })

  it('is true once the flag is set', () => {
    expect(isCustomized(file({ customized: true }))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Task spec                                                          */
/* ------------------------------------------------------------------ */

describe('buildTaskSpec', () => {
  it('sends the panel\'s boost value for an unedited file', () => {
    const spec = buildTaskSpec(file({ operation: 'boost', boostPercent: 10 }), globals())
    expect(spec.operation).toBe('boost')
    expect(spec.boostPercent).toBe(100)
    expect(spec.boostOptions?.percent).toBe(100)
  })

  it('prefers boostOptions.percent when the two values disagree', () => {
    // The advanced panel and its presets edit boostOptions.percent; that is
    // the authority whenever the flat mirror has drifted.
    const g = globals({ boostPercent: 10, boostOptions: { percent: 75, limiter: true, limiterCeiling: -1, hpfHz: 0 } })
    expect(buildTaskSpec(file(), g).boostPercent).toBe(75)
  })

  it('falls back to boostPercent when boostOptions has no percent', () => {
    const g = globals({ boostPercent: 60, boostOptions: { limiter: true, limiterCeiling: -1, hpfHz: 0 } as never })
    expect(buildTaskSpec(file(), g).boostPercent).toBe(60)
  })

  it('attaches only the options the chosen operation consumes', () => {
    const boost = buildTaskSpec(file(), globals({ operation: 'boost' }))
    expect(boost.boostOptions).toBeDefined()
    expect(boost.convertOptions).toBeUndefined()
    expect(boost.normalizeOptions).toBeUndefined()
    expect(boost.compressOptions).toBeUndefined()
    expect(boost.extractOptions).toBeUndefined()

    const convert = buildTaskSpec(file(), globals({ operation: 'convert' }))
    expect(convert.convertOptions).toBeDefined()
    expect(convert.boostPercent).toBeUndefined()
    expect(convert.boostOptions).toBeUndefined()
  })

  it('carries the file path and output directory through', () => {
    const spec = buildTaskSpec(file({ path: 'D:/in/clip.mp4' }), globals(), 'D:/out')
    expect(spec.filePath).toBe('D:/in/clip.mp4')
    expect(spec.outputDir).toBe('D:/out')
  })

  it('routes each operation to its own options bag', () => {
    for (const [operation, key] of [
      ['normalize', 'normalizeOptions'],
      ['convert', 'convertOptions'],
      ['extract', 'extractOptions'],
      ['compress', 'compressOptions']
    ] as const) {
      const spec = buildTaskSpec(file(), globals({ operation })) as Record<string, unknown>
      expect(spec.operation).toBe(operation)
      expect(spec[key]).toBeDefined()
    }
  })

  it('honours a customized file over the panel', () => {
    const edited = file({
      customized: true,
      operation: 'boost',
      boostPercent: 15,
      boostOptions: { percent: 15, limiter: true, limiterCeiling: -0.3, hpfHz: 60 }
    })
    const spec = buildTaskSpec(edited, globals())
    expect(spec.boostPercent).toBe(15)
    expect(spec.boostOptions?.limiterCeiling).toBe(-0.3)
  })
})

/* ------------------------------------------------------------------ */
/*  Store integration                                                  */
/* ------------------------------------------------------------------ */

describe('store integration', () => {
  beforeEach(() => {
    useAppStore.setState({
      files: [],
      operation: 'convert',
      boostPercent: 10,
      boostOptions: { percent: 10, limiter: true, limiterCeiling: -1, hpfHz: 0 }
    })
  })

  it('reproduces the reported flow: add files, then set the boost', () => {
    const store = useAppStore.getState()
    store.addFiles([file()])

    // The user switches to Volume and drags the slider to +100 %.
    useAppStore.getState().setOperation('boost')
    useAppStore.getState().setBoostPercent(100)

    const state = useAppStore.getState()
    const spec = buildTaskSpec(state.files[0], state)

    expect(spec.operation).toBe('boost')
    expect(spec.boostPercent).toBe(100)
    // Before the fix this dispatched the add-time snapshot of +10 %.
    expect(spec.boostPercent).not.toBe(10)
  })

  it('marks a file customized once it is edited individually', () => {
    const store = useAppStore.getState()
    store.addFiles([file()])
    expect(isCustomized(useAppStore.getState().files[0])).toBe(false)

    useAppStore.getState().updateFileOperation('C:/media/movie.mkv', 'boost', { boostPercent: 33 })
    expect(isCustomized(useAppStore.getState().files[0])).toBe(true)
  })

  it('stops the panel overriding a file after it has been edited', () => {
    const store = useAppStore.getState()
    store.addFiles([file()])
    useAppStore.getState().updateFileOperation('C:/media/movie.mkv', 'boost', {
      boostPercent: 33,
      boostOptions: { percent: 33, limiter: true, limiterCeiling: -1, hpfHz: 0 }
    })

    useAppStore.getState().setBoostPercent(100)

    const state = useAppStore.getState()
    expect(buildTaskSpec(state.files[0], state).boostPercent).toBe(33)
  })

  it('keeps untouched files tracking the panel while an edited one holds', () => {
    const store = useAppStore.getState()
    store.addFiles([file({ path: 'C:/a.mkv', name: 'a.mkv' }), file({ path: 'C:/b.mkv', name: 'b.mkv' })])

    useAppStore.getState().setOperation('boost')
    useAppStore.getState().updateFileOperation('C:/a.mkv', 'boost', {
      boostPercent: 20,
      boostOptions: { percent: 20, limiter: true, limiterCeiling: -1, hpfHz: 0 }
    })
    useAppStore.getState().setBoostPercent(250)

    const state = useAppStore.getState()
    const specs = state.files.map((f) => buildTaskSpec(f, state))
    expect(specs.find((s) => s.filePath === 'C:/a.mkv')!.boostPercent).toBe(20)
    expect(specs.find((s) => s.filePath === 'C:/b.mkv')!.boostPercent).toBe(250)
  })

  it('keeps setBoostPercent and boostOptions.percent in step', () => {
    useAppStore.getState().setBoostPercent(45)
    const state = useAppStore.getState()
    expect(state.boostPercent).toBe(45)
    expect(state.boostOptions.percent).toBe(45)
  })

  it('keeps setBoostOptions and boostPercent in step', () => {
    useAppStore.getState().setBoostOptions({ percent: 80 })
    const state = useAppStore.getState()
    expect(state.boostPercent).toBe(80)
    expect(state.boostOptions.percent).toBe(80)
  })

  it('applies a preset through to the dispatched spec', () => {
    const store = useAppStore.getState()
    store.addFiles([file()])
    useAppStore.getState().setOperation('boost')
    // "Maximize" is +100 % into a -0.3 dBTP ceiling.
    useAppStore.getState().setBoostOptions({ percent: 100, limiter: true, limiterCeiling: -0.3, hpfHz: 0 })

    const state = useAppStore.getState()
    const spec = buildTaskSpec(state.files[0], state)
    expect(spec.boostPercent).toBe(100)
    expect(spec.boostOptions?.limiterCeiling).toBe(-0.3)
  })
})
