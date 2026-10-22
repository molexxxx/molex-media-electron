/**
 * @module components/layout/PopoutShell
 * @description The pop-out player's window: a caption bar to drag it by, with the window size presets, keep on top,
 * back to the app, minimize, and close, above the compact player.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Icon } from '../../../ui/Icon'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { MediaPlayer } from '../../player'
import { PLAYER_COPY } from '../../player/copy'

/** The pop-out's window sizes, in px. */
export const SIZE_PRESETS = [
  { id: 'small', label: 'Small', w: 360, h: 480 },
  { id: 'medium', label: 'Medium', w: 420, h: 560 },
  { id: 'large', label: 'Large', w: 560, h: 680 }
] as const

/** The preset a saved size matches, or null for a size the user set. */
export function presetFor(width: number, height: number): string | null
{
  return SIZE_PRESETS.find((preset) => preset.w === width && preset.h === height)?.id ?? null
}

/** The size menu: the three presets as a choice, then remembering the window's current size. */
export function sizeEntries(active: string | null, apply: (w: number, h: number) => void, remember: () => void): MenuEntry[]
{
  return [
    ...SIZE_PRESETS.map((preset): MenuEntry => ({
      kind: 'radio',
      group: 'size',
      id: `size-${preset.id}`,
      label: preset.label,
      description: `${preset.w} × ${preset.h}`,
      checked: active === preset.id,
      onSelect: () => apply(preset.w, preset.h)
    })),
    'separator',
    { id: 'remember', label: PLAYER_COPY.rememberSize, description: active === null ? 'This size is remembered' : undefined, onSelect: remember }
  ]
}

/** The pop-out window. */
export function PopoutShell(): ReactElement
{
  const [pinned, setPinned] = useState(true)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() =>
  {
    void window.api.isPinned?.().then(setPinned)
    void window.api.getPopoutSize?.().then(({ width, height }) => setActive(presetFor(width, height)))
  }, [])

  const togglePin = useCallback(async (): Promise<void> =>
  {
    setPinned(await window.api.togglePin())
  }, [])

  const apply = useCallback(async (w: number, h: number): Promise<void> =>
  {
    await window.api.resizePopout(w, h, true)
    setActive(presetFor(w, h))
  }, [])

  const remember = useCallback(async (): Promise<void> =>
  {
    await window.api.resizePopout(window.outerWidth, window.outerHeight, true)
    setActive(presetFor(window.outerWidth, window.outerHeight))
  }, [])

  return (
    <div className="flex h-full flex-col bg-ground">
      <header className="drag-region flex h-(--size-titlebar) shrink-0 items-center gap-2 border-b border-rail-edge bg-rail ps-2" data-part="popout-caption">
        <span className="flex text-ink-3" aria-hidden="true"><Icon name="action.reorder" size="sm" /></span>
        <span className="min-w-0 flex-1 truncate text-label font-semibold text-ink-2">
          {PLAYER_COPY.page}
          <span className="font-normal text-ink-3"> · molexMedia</span>
        </span>
        <div className="no-drag flex items-center self-stretch">
          <div className="flex items-center gap-0.5 pe-1">
            <Menu
              label={PLAYER_COPY.windowSize}
              items={sizeEntries(active, (w, h) => void apply(w, h), () => void remember())}
              align="end"
              trigger={<IconButton label={PLAYER_COPY.windowSize} icon="popout.size" />}
            />
            <IconButton
              label={pinned ? PLAYER_COPY.stopKeepingOnTop : PLAYER_COPY.keepOnTop}
              icon={pinned ? 'popout.pin' : 'popout.unpin'}
              pressed={pinned}
              onClick={() => void togglePin()}
            />
            <IconButton label={PLAYER_COPY.backToApp} icon="player.returnToApp" onClick={() => void window.api.returnPlayerToApp()} />
          </div>
          <IconButton size="caption" label={PLAYER_COPY.minimize} icon="window.minimize" onClick={() => window.api.windowMinimize?.()} />
          <IconButton size="caption" variant="danger" label={PLAYER_COPY.close} icon="window.close" onClick={() => window.api.windowClose?.()} />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <MediaPlayer popout />
      </main>
    </div>
  )
}
