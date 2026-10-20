/**
 * @module components/presets/PresetGuide
 * @description A built-in preset's guidance, shared by the Batch inspector and Settings: the use in plain words, how
 * it gets there, a pointer to a better preset for a nearby case, and a related setting worth changing with it. The
 * goal finder lists common goals per operation, each answered by one preset.
 */
import type { ReactElement } from 'react'
import { operationLabel } from '../../../../shared/jobs/describe'
import { findPreset } from '../../../../shared/jobs/presets'
import type { Operation } from '../../../../shared/jobs/recipes'
import { PRESET_GOALS, presetGuide } from '../../copy/presetGuides'
import type { FieldPatch } from '../../stores/recipeFields'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'

const INLINE_LINK = 'text-ink underline decoration-line-control underline-offset-2 transition-colors duration-fast ease-out hover:decoration-ink'

/** Props for {@link PresetGuideText}. */
export interface PresetGuideTextProps
{
  op: Operation
  presetId: string
  /** Applies another preset of the same operation; without it a pointer names the preset as text. */
  onUsePreset?: (presetId: string) => void
  /** Applies a tip's setting to the selected jobs; without it the tip shows as text. */
  onTip?: (patch: FieldPatch, field: string) => void
  className?: string
}

/** The pointer's preset name: a button that applies it when it shares the operation and `onUse` is given. */
function PointerName({ op, presetId, onUse }: { op: Operation, presetId: string, onUse?: (presetId: string) => void }): ReactElement | null
{
  const target = findPreset(presetId)
  if (target === null)
  {
    return null
  }
  if (target.op === op && onUse !== undefined)
  {
    return <button type="button" className={INLINE_LINK} onClick={() => onUse(target.id)}>{`Use ${target.label}`}</button>
  }
  return <span className="text-ink">{target.op === op ? target.label : `${operationLabel(target.op)}: ${target.label}`}</span>
}

/** A built-in preset's guidance, or nothing for a user preset. */
export function PresetGuideText({ op, presetId, onUsePreset, onTip, className }: PresetGuideTextProps): ReactElement | null
{
  const guide = presetGuide(op, presetId)
  if (guide === null)
  {
    return null
  }
  const tip = guide.tip
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)} data-preset-guide={presetId}>
      <p className="text-body text-ink">{guide.bestFor}</p>
      <p className="max-w-[68ch] text-label text-ink-2">{guide.how}</p>
      {guide.instead !== undefined && (
        <p className="text-label text-ink-3">
          {guide.instead.when}{' '}
          <PointerName op={op} presetId={guide.instead.presetId} onUse={onUsePreset} />
        </p>
      )}
      {tip !== undefined && (
        <div className="mt-1 flex flex-col items-start gap-2 rounded-sm bg-sunken px-3 py-2.5 shadow-well">
          <p className="max-w-[68ch] text-label text-ink-2">{tip.text}</p>
          {tip.action !== undefined && onTip !== undefined && (
            <Button size="sm" variant="secondary" onClick={() => onTip(tip.action!.patch, tip.action!.field)}>{tip.action.label}</Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Props for {@link GoalFinder}. */
export interface GoalFinderProps
{
  op: Operation
  /** The preset in use, whose goal is marked. */
  current: string | null
  onChoose: (presetId: string) => void
  /** `stacked` puts the preset under its goal for a narrow panel; `columns` sets them side by side. */
  layout?: 'stacked' | 'columns'
  className?: string
}

/** The words of the goal finder. */
export const GOAL_WORDS = {
  heading: 'Choose by goal',
  inUse: 'In use'
} as const

/** Common goals for an operation, each a button that chooses its preset; the goal of the preset in use is marked. */
export function GoalFinder({ op, current, onChoose, layout = 'stacked', className }: GoalFinderProps): ReactElement
{
  return (
    <ul aria-label={`${operationLabel(op)} goals`} className={cx('flex flex-col', className)}>
      {PRESET_GOALS[op].map((goal) =>
      {
        const preset = findPreset(goal.presetId)
        const active = goal.presetId === current
        return (
          <li key={goal.goal}>
            <button
              type="button"
              aria-current={active || undefined}
              onClick={() => onChoose(goal.presetId)}
              className={cx(
                'flex w-full min-w-0 rounded-sm px-2 py-1.5 text-start transition-colors duration-fast ease-out hover:bg-wash-hover',
                layout === 'columns' ? 'grid grid-cols-[minmax(0,24rem)_minmax(0,1fr)] items-baseline gap-4' : 'flex-col gap-0.5',
                active && 'bg-wash-selected hover:bg-wash-selected-hover'
              )}
            >
              <span className="text-body text-ink">{goal.goal}</span>
              <span className={cx('text-label', active ? 'text-accent-ink' : 'text-ink-2')}>
                {preset?.label}
                {active && <span className="sr-only">{`, ${GOAL_WORDS.inUse}`}</span>}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
