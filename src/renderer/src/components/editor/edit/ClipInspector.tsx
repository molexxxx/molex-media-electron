/**
 * @module editor/edit/ClipInspector
 * The timeline's side panel for the selected clip, laid out as the Batch inspector: the clip and where it sits,
 * lit timing readouts, its sound (mute, volume, pan), and its picture for video clips. Slider drags update live
 * and commit one undo step on release.
 */
import { useId, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { Slider } from '../../../ui/Slider'
import { TransformInspector } from '../inspect/TransformInspector'
import { SwitchRow } from '../shared/Field'
import { formatTimecode, Readout } from '../shared/TimeDisplay'
import type { TimelineClip } from '../types'
import { trackTitle } from './TrackHeader'

/** A pan position in words: "Center", "Left 30", "Right 100". */
export function panWords(pan: number): string
{
  const amount = Math.round(Math.abs(pan) * 100)
  if (amount === 0)
  {
    return 'Center'
  }
  return pan < 0 ? `Left ${amount}` : `Right ${amount}`
}

function setLive(clipId: string, patch: Partial<Pick<TimelineClip, 'volume' | 'pan'>>): void
{
  useEditorStore.setState((s) => ({
    timeline: { ...s.timeline, clips: s.timeline.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) }
  }))
}

function ClipDetails({ clip }: { clip: TimelineClip }): ReactElement
{
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const track = useEditorStore((s) => s.timeline.tracks.find((t) => t.id === clip.trackId))
  const source = useEditorStore((s) => s.sources.find((src) => src.id === clip.sourceId))
  const setClipVolume = useEditorStore((s) => s.setClipVolume)
  const setClipPan = useEditorStore((s) => s.setClipPan)
  const toggleClipMuted = useEditorStore((s) => s.toggleClipMuted)
  const soundId = useId()
  const length = (clip.sourceOut - clip.sourceIn) / clip.speed
  const isVideo = track?.type === 'video' && (source?.width ?? 0) > 0

  return (
    <>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="truncate text-section text-ink">{clip.name || source?.fileName || 'Clip'}</h2>
        <p className="truncate text-label text-ink-3">
          {track ? trackTitle(track) : 'No track'}
          {clip.speed !== 1 ? ` · ${clip.speed.toFixed(2)}× speed` : ''}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Readout label="Starts at" value={formatTimecode(clip.timelineStart, frameRate)} />
        <Readout label="Length" value={formatTimecode(length, frameRate)} />
        <Readout label="Source in" value={formatTimecode(clip.sourceIn, frameRate)} lit={false} />
        <Readout label="Source out" value={formatTimecode(clip.sourceOut, frameRate)} lit={false} />
      </div>
      <section aria-labelledby={soundId} className="flex flex-col gap-4">
        <h3 id={soundId} className="type-legend text-accent-ink">Sound</h3>
        <SwitchRow label="Mute this clip" checked={clip.muted} onChange={() => toggleClipMuted(clip.id)} />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-body text-ink">Volume</span>
            <span className="text-label tabular-nums text-ink-2">{Math.round(clip.volume * 100)}%</span>
          </div>
          <Slider
            label="Volume"
            value={Math.round(clip.volume * 100)}
            min={0}
            max={200}
            step={1}
            bigStep={10}
            valueText={(v) => `${v}%`}
            onInput={(v) => setLive(clip.id, { volume: v / 100 })}
            onChange={(v) => setClipVolume(clip.id, v / 100)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-body text-ink">Pan</span>
            <span className="flex items-center gap-2">
              <span className="text-label tabular-nums text-ink-2">{panWords(clip.pan)}</span>
              {clip.pan !== 0 && <Button size="sm" variant="ghost" onClick={() => setClipPan(clip.id, 0)}>Center</Button>}
            </span>
          </div>
          <Slider
            label="Pan"
            value={Math.round(clip.pan * 100)}
            min={-100}
            max={100}
            step={1}
            bigStep={10}
            valueText={(v) => panWords(v / 100)}
            onInput={(v) => setLive(clip.id, { pan: v / 100 })}
            onChange={(v) => setClipPan(clip.id, v / 100)}
          />
        </div>
      </section>
      {isVideo && <TransformInspector clip={clip} />}
    </>
  )
}

/** Props of {@link ClipInspector}. */
export interface ClipInspectorProps
{
  width: number
}

/** The panel. */
export function ClipInspector({ width }: ClipInspectorProps): ReactElement
{
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const clip = useEditorStore((s) => (s.selectedClipIds.length === 1 ? s.timeline.clips.find((c) => c.id === s.selectedClipIds[0]) : undefined))
  const headingId = useId()

  return (
    <aside aria-label="Clip" style={{ width }} className="flex min-h-0 shrink-0 flex-col bg-panel" data-panel="clip-inspector">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto ps-5 pe-3 py-4">
        {clip
          ? <ClipDetails key={clip.id} clip={clip} />
          : (
              <div className="flex flex-col gap-1">
                <h2 id={headingId} className="text-section text-ink">
                  {selectedClipIds.length > 1 ? `${selectedClipIds.length} clips selected` : 'No clip selected'}
                </h2>
                <p className="text-label text-ink-3">
                  {selectedClipIds.length > 1
                    ? 'Select one clip to change its sound and picture. Delete removes the selected clips.'
                    : 'Select a clip on the timeline to change its sound, its place in the picture, and its keyframes.'}
                </p>
              </div>
            )}
      </div>
    </aside>
  )
}
