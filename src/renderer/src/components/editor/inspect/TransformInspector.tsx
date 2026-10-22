/**
 * @module editor/inspect/TransformInspector
 * The selected clip's place in the picture: position, scale with a linked aspect, rotation, anchor, opacity, and
 * blend mode, with a keyframe at the playhead. Fields take typed values and arrow keys; drag a field's letter
 * sideways to scrub it, which commits one undo step on release.
 */
import { useCallback, useId, useMemo, useState, type PointerEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { IconButton } from '../../../ui/IconButton'
import { NumberField } from '../../../ui/NumberField'
import { Select, type SelectOption } from '../../../ui/Select'
import { Slider } from '../../../ui/Slider'
import { EditorField } from '../shared/Field'
import { resolveTransform } from '../shared/interpolation'
import type { BlendMode, ClipTransform, TimelineClip } from '../types'
import { defaultTransform } from '../types'

const BLEND_OPTIONS: SelectOption[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'add', label: 'Add' },
  { value: 'difference', label: 'Difference' }
]

/** Sets a clip's transform for a live gesture without an undo step; the gesture's end commits one. */
function setLive(clipId: string, partial: Partial<ClipTransform>, fallback: ClipTransform): void
{
  useEditorStore.setState((s) => ({
    timeline: {
      ...s.timeline,
      clips: s.timeline.clips.map((c) => (c.id === clipId ? { ...c, transform: { ...(c.transform ?? fallback), ...partial } } : c))
    }
  }))
}

interface ScrubProps
{
  /** The visible letter, such as X. */
  letter: string
  value: number
  /** How much one px of drag changes the value. */
  perPixel: number
  min?: number
  max?: number
  onLive: (value: number) => void
  onCommit: (value: number) => void
}

/** A field's letter that scrubs its value when dragged sideways. */
function Scrub({ letter, value, perPixel, min, max, onLive, onCommit }: ScrubProps): ReactElement
{
  const onPointerDown = (event: PointerEvent<HTMLSpanElement>): void =>
  {
    if (event.button !== 0)
    {
      return
    }
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const startX = event.clientX
    let last = value
    const clampValue = (next: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next))
    const move = (moveEvent: globalThis.PointerEvent): void =>
    {
      last = clampValue(value + (moveEvent.clientX - startX) * perPixel)
      onLive(last)
    }
    const end = (): void =>
    {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', end)
      element.removeEventListener('pointercancel', end)
      if (last !== value)
      {
        onCommit(last)
      }
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', end)
    element.addEventListener('pointercancel', end)
  }
  return (
    <span
      aria-hidden="true"
      className="w-3 shrink-0 cursor-ew-resize touch-none select-none text-center text-label font-semibold text-ink-3 hover:text-ink"
      onPointerDown={onPointerDown}
    >
      {letter}
    </span>
  )
}

interface AxisFieldProps
{
  letter: string
  label: string
  value: number
  step: number
  perPixel: number
  min?: number
  max?: number
  unit?: string
  onLive: (value: number) => void
  onCommit: (value: number) => void
}

function AxisField({ letter, label, value, step, perPixel, min, max, unit, onLive, onCommit }: AxisFieldProps): ReactElement
{
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Scrub letter={letter} value={value} perPixel={perPixel} min={min} max={max} onLive={onLive} onCommit={onCommit} />
      <NumberField label={label} value={value} step={step} min={min} max={max} unit={unit} size="sm" onCommit={onCommit} className="min-w-0 flex-1" />
    </div>
  )
}

/** The transform fields for one clip. */
export function TransformInspector({ clip }: { clip: TimelineClip }): ReactElement
{
  const sources = useEditorStore((s) => s.sources)
  const resolution = useEditorStore((s) => s.project.resolution)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const setClipTransform = useEditorStore((s) => s.setClipTransform)
  const addKeyframe = useEditorStore((s) => s.addKeyframe)
  const removeKeyframe = useEditorStore((s) => s.removeKeyframe)
  const setClipBlendMode = useEditorStore((s) => s.setClipBlendMode)
  const [linked, setLinked] = useState(true)
  const ids = { rotation: useId(), opacity: useId(), blend: useId(), anchor: useId(), position: useId(), scale: useId() }

  const source = sources.find((s) => s.id === clip.sourceId)
  const base = useMemo<ClipTransform>(() => (source && source.width > 0
    ? defaultTransform(source.width, source.height, resolution.width, resolution.height)
    : { x: resolution.width / 2, y: resolution.height / 2, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, opacity: 1 }), [source, resolution])
  const frameOffset = currentFrame - clip.timelineStart
  const transform = useMemo(() => resolveTransform(clip, frameOffset, base), [clip, frameOffset, base])
  const keyframeHere = (clip.keyframes ?? []).some((k) => k.frame === frameOffset)
  const keyframeCount = clip.keyframes?.length ?? 0

  const commit = useCallback((partial: Partial<ClipTransform>) => setClipTransform(clip.id, partial), [clip.id, setClipTransform])
  const live = useCallback((partial: Partial<ClipTransform>) => setLive(clip.id, partial, base), [clip.id, base])

  const scalePatch = (axis: 'x' | 'y', percent: number): Partial<ClipTransform> =>
  {
    const next = percent / 100
    if (!linked)
    {
      return axis === 'x' ? { scaleX: next } : { scaleY: next }
    }
    const current = axis === 'x' ? transform.scaleX : transform.scaleY
    const ratio = current !== 0 ? next / current : 1
    return axis === 'x' ? { scaleX: next, scaleY: transform.scaleY * ratio } : { scaleY: next, scaleX: transform.scaleX * ratio }
  }

  const toggleKeyframe = (): void =>
  {
    if (keyframeHere)
    {
      removeKeyframe(clip.id, frameOffset)
    }
    else
    {
      addKeyframe(clip.id, frameOffset, transform)
    }
  }

  const round = (value: number, places: number): number => Number(value.toFixed(places))

  return (
    <section aria-labelledby={`${ids.position}-legend`} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${ids.position}-legend`} className="type-legend text-accent-ink">Picture</h3>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label={keyframeHere ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'}
            icon="editor.keyframe"
            pressed={keyframeHere}
            onClick={toggleKeyframe}
          />
          <IconButton size="sm" label="Reset the picture to fit the frame" icon="action.retry" onClick={() => commit(base)} />
        </div>
      </div>
      <EditorField label="Position" captionId={ids.position}>
        <div role="group" aria-labelledby={ids.position} className="grid grid-cols-2 gap-2">
          <AxisField letter="X" label="Position X" value={round(transform.x, 1)} step={1} perPixel={1} unit="px" onLive={(x) => live({ x })} onCommit={(x) => commit({ x })} />
          <AxisField letter="Y" label="Position Y" value={round(transform.y, 1)} step={1} perPixel={1} unit="px" onLive={(y) => live({ y })} onCommit={(y) => commit({ y })} />
        </div>
      </EditorField>
      <EditorField label="Scale" captionId={ids.scale}>
        <div className="flex items-center gap-1">
          <div role="group" aria-labelledby={ids.scale} className="grid min-w-0 flex-1 grid-cols-2 gap-2">
            <AxisField
              letter="X"
              label="Scale X"
              value={round(transform.scaleX * 100, 1)}
              step={1}
              perPixel={0.5}
              min={1}
              max={1000}
              unit="%"
              onLive={(v) => live(scalePatch('x', v))}
              onCommit={(v) => commit(scalePatch('x', v))}
            />
            <AxisField
              letter="Y"
              label="Scale Y"
              value={round(transform.scaleY * 100, 1)}
              step={1}
              perPixel={0.5}
              min={1}
              max={1000}
              unit="%"
              onLive={(v) => live(scalePatch('y', v))}
              onCommit={(v) => commit(scalePatch('y', v))}
            />
          </div>
          <IconButton
            size="sm"
            label={linked ? 'Scale X and Y separately' : 'Keep the aspect ratio when scaling'}
            icon={linked ? 'editor.linked' : 'editor.unlinked'}
            pressed={linked}
            onClick={() => setLinked(!linked)}
          />
        </div>
      </EditorField>
      <EditorField label="Rotation" htmlFor={ids.rotation}>
        <NumberField id={ids.rotation} value={round(transform.rotation, 1)} step={0.5} min={-360} max={360} unit="°" size="sm" onCommit={(rotation) => commit({ rotation })} />
      </EditorField>
      <EditorField label="Anchor" captionId={ids.anchor} note="Where the clip turns and scales from, as a share of its width and height.">
        <div role="group" aria-labelledby={ids.anchor} className="grid grid-cols-2 gap-2">
          <AxisField
            letter="X"
            label="Anchor X"
            value={Math.round(transform.anchorX * 100)}
            step={1}
            perPixel={0.5}
            min={0}
            max={100}
            unit="%"
            onLive={(v) => live({ anchorX: v / 100 })}
            onCommit={(v) => commit({ anchorX: v / 100 })}
          />
          <AxisField
            letter="Y"
            label="Anchor Y"
            value={Math.round(transform.anchorY * 100)}
            step={1}
            perPixel={0.5}
            min={0}
            max={100}
            unit="%"
            onLive={(v) => live({ anchorY: v / 100 })}
            onCommit={(v) => commit({ anchorY: v / 100 })}
          />
        </div>
      </EditorField>
      <EditorField label="Opacity" htmlFor={ids.opacity}>
        <div className="flex items-center gap-3">
          <Slider
            label="Opacity"
            value={Math.round(transform.opacity * 100)}
            min={0}
            max={100}
            step={1}
            valueText={(v) => `${v}%`}
            onInput={(v) => live({ opacity: v / 100 })}
            onChange={(v) => commit({ opacity: v / 100 })}
            className="min-w-0 flex-1"
          />
          <NumberField id={ids.opacity} value={Math.round(transform.opacity * 100)} step={1} min={0} max={100} unit="%" size="sm" onCommit={(v) => commit({ opacity: v / 100 })} className="w-20" />
        </div>
      </EditorField>
      <EditorField label="Blend mode" htmlFor={ids.blend}>
        <Select id={ids.blend} size="sm" value={clip.blendMode ?? 'normal'} options={BLEND_OPTIONS} onChange={(mode) => setClipBlendMode(clip.id, mode as BlendMode)} className="w-full" />
      </EditorField>
      <p className="text-label text-ink-3">
        {keyframeCount === 0
          ? 'No keyframes. Add one to animate the picture from this point.'
          : `${keyframeCount} ${keyframeCount === 1 ? 'keyframe' : 'keyframes'}${keyframeHere ? ', one at the playhead' : ''}.`}
      </p>
    </section>
  )
}
