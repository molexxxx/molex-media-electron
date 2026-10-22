/**
 * Icon registry and Icon: every key maps to its canonical lucide-react export (never a deprecated alias),
 * rendered icons are hidden from assistive technology at the three sizes, and the provider draws one
 * stroke at every size. Also covers the primitives barrel and the shared helpers it re-exports: the token
 * readers for canvas code and the top-layer wrappers overlay primitives call.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import * as lucide from 'lucide-react'
import { ICONS, ICON_NAMES, ICON_SIZES, ICON_STROKE_WIDTH, type IconName } from '../../../src/renderer/src/ui/icons'
import { Icon, IconProvider } from '../../../src/renderer/src/ui/Icon'
import * as ui from '../../../src/renderer/src/ui'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')

/** The registry table: key to lucide-react export name. */
const EXPECTED: Record<IconName, string> = {
  'op.convert': 'ArrowRightLeft',
  'op.normalize': 'Gauge',
  'op.boost': 'Volume2',
  'op.compress': 'Shrink',
  'op.extract': 'PackageOpen',
  'status.pending': 'CircleDashed',
  'status.queued': 'Clock',
  'status.active': 'LoaderCircle',
  'status.paused': 'CirclePause',
  'status.done': 'CircleCheck',
  'status.verified': 'BadgeCheck',
  'status.warning': 'TriangleAlert',
  'status.failed': 'OctagonX',
  'status.canceled': 'Ban',
  'status.skipped': 'SkipForward',
  'status.locked': 'Lock',
  'status.missing': 'FileX',
  'action.addFiles': 'FilePlus',
  'action.addFolder': 'FolderPlus',
  'action.review': 'ListChecks',
  'action.start': 'Play',
  'action.resume': 'Play',
  'action.pause': 'Pause',
  'action.stop': 'Square',
  'action.skip': 'SkipForward',
  'action.retry': 'RotateCcw',
  'action.edit': 'Pencil',
  'action.remove': 'X',
  'action.clearFinished': 'ListX',
  'action.reveal': 'FolderOpen',
  'action.browse': 'FolderOpen',
  'action.trash': 'Trash2',
  'action.showLog': 'ScrollText',
  'action.copy': 'Copy',
  'action.export': 'Download',
  'action.save': 'Save',
  'action.acknowledge': 'Check',
  'action.pin': 'Pin',
  'action.paste': 'ClipboardPaste',
  'action.locate': 'FileSearch',
  'action.relink': 'Link',
  'action.takeOut': 'ListMinus',
  'action.selectSimilar': 'Layers',
  'action.shortcuts': 'Keyboard',
  'action.filter': 'ListFilter',
  'action.search': 'Search',
  'action.sortAscending': 'ArrowUp',
  'action.sortDescending': 'ArrowDown',
  'action.sortNone': 'ArrowUpDown',
  'action.reorder': 'GripVertical',
  'action.moveUp': 'ArrowUp',
  'action.moveDown': 'ArrowDown',
  'action.moveTop': 'ArrowUpToLine',
  'action.moveBottom': 'ArrowDownToLine',
  'action.more': 'Ellipsis',
  'action.expand': 'ChevronRight',
  'action.collapse': 'ChevronDown',
  'action.openMenu': 'ChevronDown',
  'action.close': 'X',
  'action.info': 'Info',
  'action.external': 'ExternalLink',
  'action.next': 'ArrowRight',
  'system.workers': 'Cpu',
  'system.gpu': 'Gpu',
  'system.memory': 'MemoryStick',
  'system.disk': 'HardDrive',
  'system.ffmpeg': 'SquareTerminal',
  'nav.dashboard': 'LayoutDashboard',
  'nav.batch': 'ListOrdered',
  'nav.history': 'RotateCcwClock',
  'nav.editor': 'Clapperboard',
  'nav.player': 'MonitorPlay',
  'nav.settings': 'Settings',
  'nav.logs': 'ScrollText',
  'rail.collapse': 'PanelLeftClose',
  'rail.expand': 'PanelLeftOpen',
  'window.minimize': 'Minus',
  'window.maximize': 'Square',
  'window.restore': 'Copy',
  'window.close': 'X',
  'update.available': 'CircleArrowUp',
  'popout.pin': 'Pin',
  'popout.unpin': 'PinOff',
  'popout.size': 'Maximize2',
  'player.repeat': 'Repeat',
  'player.repeatOne': 'Repeat1',
  'player.play': 'Play',
  'player.pause': 'Pause',
  'player.previous': 'SkipBack',
  'player.next': 'SkipForward',
  'player.shuffle': 'Shuffle',
  'player.volume': 'Volume2',
  'player.volumeLow': 'Volume1',
  'player.muted': 'VolumeX',
  'player.popout': 'PictureInPicture2',
  'player.returnToApp': 'SquareArrowOutDownLeft',
  'player.addLink': 'Link',
  'player.playlist': 'ListMusic',
  'player.visualization': 'AudioWaveform',
  'player.video': 'Film',
  'player.audioTrack': 'AudioLines',
  'player.subtitles': 'Captions',
  'player.mediaInfo': 'Info',
  'player.fullScreen': 'Maximize',
  'player.exitFullScreen': 'Minimize',
  'editor.select': 'MousePointer2',
  'editor.trimEdges': 'MoveHorizontal',
  'editor.split': 'Scissors',
  'editor.snap': 'Magnet',
  'editor.zoomIn': 'ZoomIn',
  'editor.zoomOut': 'ZoomOut',
  'editor.fit': 'Expand',
  'editor.undo': 'Undo2',
  'editor.redo': 'Redo2',
  'editor.visible': 'Eye',
  'editor.hidden': 'EyeOff',
  'editor.sound': 'Volume2',
  'editor.muted': 'VolumeX',
  'editor.lock': 'Lock',
  'editor.unlock': 'LockOpen',
  'editor.add': 'Plus',
  'editor.stepBack': 'StepBack',
  'editor.stepForward': 'StepForward',
  'editor.toIn': 'ArrowLeftToLine',
  'editor.toOut': 'ArrowRightToLine',
  'editor.keyframe': 'Diamond',
  'editor.linked': 'Link2',
  'editor.unlinked': 'Unlink2',
  'editor.sources': 'PanelLeft',
  'editor.inspector': 'PanelRight',
  'editor.insert': 'BetweenVerticalStart',
  'editor.overwrite': 'Replace',
  'editor.append': 'ListEnd',
  'editor.onTop': 'Layers2'
}

const BATCH_KEYS: Array<[IconName, string]> = [
  ['action.pin', 'Pin'],
  ['action.paste', 'ClipboardPaste'],
  ['action.locate', 'FileSearch'],
  ['action.relink', 'Link'],
  ['action.takeOut', 'ListMinus'],
  ['action.selectSimilar', 'Layers'],
  ['action.shortcuts', 'Keyboard'],
  ['nav.history', 'RotateCcwClock']
]

type LucideExport = { displayName?: string }

function lucideExport(name: string): LucideExport | undefined
{
  return (lucide as unknown as Record<string, LucideExport | undefined>)[name]
}

function registryImports(): string[]
{
  const source = fs.readFileSync(path.join(REPO, 'src/renderer/src/ui/icons.ts'), 'utf8')
  const block = /import\s*\{([^}]*)\}\s*from\s*'lucide-react'/.exec(source)
  expect(block).not.toBeNull()
  return block![1].split(',').map((name) => name.trim()).filter((name) => name && !name.startsWith('type '))
}

function declaredComponents(): Set<string>
{
  const dts = fs.readFileSync(path.join(REPO, 'node_modules/lucide-react/dist/lucide-react.d.ts'), 'utf8')
  return new Set([...dts.matchAll(/^declare const ([A-Z]\w*):/gm)].map((m) => m[1]))
}

describe('icon registry', () =>
{
  it('holds exactly the keys of the registry table, each on its lucide export', () =>
  {
    expect(Object.keys(ICONS).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const [key, exportName] of Object.entries(EXPECTED) as Array<[IconName, string]>)
    {
      expect(ICONS[key], key).toBe(lucideExport(exportName))
      expect((ICONS[key] as LucideExport).displayName, key).toBe(exportName)
    }
  })

  it('imports only canonical lucide-react declarations, never an alias', () =>
  {
    const declared = declaredComponents()
    const imports = registryImports()
    expect(imports.length).toBeGreaterThan(60)
    for (const name of imports)
    {
      expect(declared.has(name), `${name} is declared by lucide-react`).toBe(true)
      expect(lucideExport(name)?.displayName, `${name} is not an alias`).toBe(name)
    }
    expect(declared.has('History')).toBe(false)
    expect(lucideExport('History')?.displayName).toBe('RotateCcwClock')
  })

  it('resolves the batch page keys, with the history tab on RotateCcwClock', () =>
  {
    for (const [key, exportName] of BATCH_KEYS)
    {
      expect(ICONS[key], key).toBe(lucideExport(exportName))
      const { container } = render(<Icon name={key} />)
      expect(container.querySelector('svg'), key).not.toBeNull()
      cleanup()
    }
  })

  it('lists every key in registry order', () =>
  {
    expect(ICON_NAMES).toEqual(Object.keys(ICONS))
  })

  it('ties the sizes to the type steps and keeps one line weight', () =>
  {
    expect(ICON_SIZES).toEqual({ sm: 14, md: 16, lg: 20 })
    expect(ICON_STROKE_WIDTH).toBe(1.5)
  })
})

describe('Icon', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('renders every registry key as an svg hidden from assistive technology', () =>
  {
    for (const name of ICON_NAMES)
    {
      const { container } = render(<Icon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg, name).not.toBeNull()
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('data-icon', name)
      expect(svg).not.toHaveAttribute('role')
      expect(svg).not.toHaveAttribute('aria-label')
      cleanup()
    }
  })

  it('draws md by default and sm and lg on request', () =>
  {
    const { container, rerender } = render(<Icon name="status.verified" />)
    expect(container.querySelector('svg')).toHaveAttribute('width', '16')
    expect(container.querySelector('svg')).toHaveAttribute('height', '16')
    rerender(<Icon name="status.verified" size="sm" />)
    expect(container.querySelector('svg')).toHaveAttribute('width', '14')
    rerender(<Icon name="status.verified" size="lg" />)
    expect(container.querySelector('svg')).toHaveAttribute('width', '20')
  })

  it('keeps its box from shrinking, merges a caller class, and spins only on request', () =>
  {
    const { container, rerender } = render(<Icon name="status.active" className="text-running" />)
    const classes = container.querySelector('svg')!.getAttribute('class')!.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['lucide', 'lucide-loader-circle', 'shrink-0', 'text-running']))
    expect(classes).not.toContain('motion-safe:animate-spin')
    rerender(<Icon name="status.active" spin />)
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('motion-safe:animate-spin')
  })

  it('leaves the name of the control it sits in to the control', () =>
  {
    render(
      <button type="button">
        <Icon name="action.close" />
        Close
      </button>
    )
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('draws a 1.5 px line at every size under the provider, and lucide defaults without it', () =>
  {
    const { container } = render(
      <IconProvider>
        <Icon name="action.export" size="sm" />
        <Icon name="action.export" />
        <Icon name="action.export" size="lg" />
      </IconProvider>
    )
    const widths = [...container.querySelectorAll('svg')].map((svg) => Number(svg.getAttribute('stroke-width')))
    expect(widths[0]).toBeCloseTo(1.5 * 24 / 14)
    expect(widths[1]).toBeCloseTo(1.5 * 24 / 16)
    expect(widths[2]).toBeCloseTo(1.5 * 24 / 20)
    cleanup()

    const bare = render(<Icon name="action.export" />)
    expect(bare.container.querySelector('svg')).toHaveAttribute('stroke-width', '2')
  })

  it('reaches direct lucide imports too, so legacy glyphs share the stroke', () =>
  {
    const { container } = render(
      <IconProvider>
        <lucide.Repeat size={14} aria-hidden="true" />
      </IconProvider>
    )
    expect(Number(container.querySelector('svg')!.getAttribute('stroke-width'))).toBeCloseTo(1.5 * 24 / 14)
  })
})

describe('primitives barrel', () =>
{
  it('re-exports the primitives and helpers that exist', () =>
  {
    const components = ['Button', 'CapsText', 'CatalogNumber', 'Icon', 'IconProvider', 'LiveRegion', 'ProgressBar', 'Splitter', 'VisuallyHidden']
    const helpers = ['cx', 'useAnnounce', 'readToken', 'fontsReady', 'showModal', 'closeDialog', 'showPopover', 'hidePopover', 'prefersReducedMotion', 'subscribeReducedMotion', 'useReducedMotion', 'nextFrame']
    for (const name of [...components, ...helpers])
    {
      expect(typeof (ui as Record<string, unknown>)[name], name).toBe('function')
    }
    expect(ui.ICONS).toBe(ICONS)
    expect(ui.ICON_NAMES).toBe(ICON_NAMES)
    expect(ui.ICON_SIZES).toBe(ICON_SIZES)
    expect(ui.ICON_STROKE_WIDTH).toBe(ICON_STROKE_WIDTH)
    expect(ui.ANNOUNCE_COALESCE_MS).toBe(500)
    expect(ui.SPLITTER_STEP).toBe(16)
    expect(ui.PROGRESS_WORKING_LABEL).toBe('Working')
  })
})

describe('token readers', () =>
{
  afterEach(() =>
  {
    document.documentElement.style.removeProperty('--color-ink')
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'fonts')
  })

  it('reads a token from the document root, trimmed, for canvas fills and strokes', () =>
  {
    document.documentElement.style.setProperty('--color-ink', ' #ece4d4 ')
    expect(ui.readToken('--color-ink')).toBe('#ece4d4')
  })

  it('falls back when the token is not set', () =>
  {
    expect(ui.readToken('--color-unset')).toBe('')
    expect(ui.readToken('--color-unset', 'currentColor')).toBe('currentColor')
  })

  it('waits for the canvas face and every pending load before canvas text draws', async () =>
  {
    const order: string[] = []
    const fonts = {
      load: vi.fn(async (font: string) =>
      {
        order.push(`load ${font}`)
        return []
      }),
      get ready(): Promise<void>
      {
        order.push('ready')
        return Promise.resolve()
      }
    }
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
    await ui.fontsReady()
    expect(order).toEqual(['load 12px "Segoe UI Variable Text"', 'ready'])
    await ui.fontsReady('14px "Cascadia Mono"')
    expect(fonts.load).toHaveBeenLastCalledWith('14px "Cascadia Mono"')
  })

  it('resolves when a font fails to load or the document has no font set', async () =>
  {
    await expect(ui.fontsReady()).resolves.toBeUndefined()
    Object.defineProperty(document, 'fonts', {
      value: { load: vi.fn(async () => { throw new Error('network') }), ready: Promise.resolve() },
      configurable: true
    })
    await expect(ui.fontsReady()).resolves.toBeUndefined()
  })
})

describe('top-layer wrappers', () =>
{
  afterEach(() =>
  {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('opens a connected dialog as a modal once, and closes it with a return value', () =>
  {
    const dialog = document.createElement('dialog')
    document.body.append(dialog)
    const showModal = vi.spyOn(dialog, 'showModal')
    const onClose = vi.fn()
    dialog.addEventListener('close', onClose)

    ui.showModal(dialog)
    ui.showModal(dialog)
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(dialog.open).toBe(true)

    ui.closeDialog(dialog, 'confirm')
    expect(dialog.open).toBe(false)
    expect(dialog.returnValue).toBe('confirm')
    expect(onClose).toHaveBeenCalledTimes(1)
    ui.closeDialog(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves a dialog outside the document closed', () =>
  {
    const dialog = document.createElement('dialog')
    const showModal = vi.spyOn(dialog, 'showModal')
    ui.showModal(dialog)
    expect(showModal).not.toHaveBeenCalled()
    expect(dialog.open).toBe(false)
  })

  it('shows and hides a connected popover and ignores one outside the document', () =>
  {
    const popover = document.createElement('div')
    popover.setAttribute('popover', 'auto')
    const show = vi.spyOn(popover, 'showPopover')
    const hide = vi.spyOn(popover, 'hidePopover')

    ui.showPopover(popover)
    ui.hidePopover(popover)
    expect(show).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()

    document.body.append(popover)
    ui.showPopover(popover)
    expect(show).toHaveBeenCalledTimes(1)
    ui.hidePopover(popover)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('treats a request the platform already satisfies as done, and rethrows anything else', () =>
  {
    const popover = document.createElement('div')
    popover.setAttribute('popover', 'auto')
    document.body.append(popover)
    vi.spyOn(popover, 'showPopover').mockImplementation(() =>
    {
      throw new DOMException('Already showing', 'InvalidStateError')
    })
    expect(() => ui.showPopover(popover)).not.toThrow()

    vi.spyOn(popover, 'hidePopover').mockImplementation(() =>
    {
      throw new DOMException('Not a popover', 'NotSupportedError')
    })
    expect(() => ui.hidePopover(popover)).toThrow('Not a popover')
  })
})
