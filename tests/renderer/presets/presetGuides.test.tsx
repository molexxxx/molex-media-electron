import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BUILTIN_PRESETS, findPreset } from '../../../src/shared/jobs/presets'
import { OPERATIONS } from '../../../src/shared/jobs/recipes'
import { PRESET_GOALS, presetGuide } from '../../../src/renderer/src/copy/presetGuides'
import { GoalFinder, PresetGuideText } from '../../../src/renderer/src/components/presets/PresetGuide'

afterEach(cleanup)

describe('preset guides', () =>
{
  it('guide every built-in preset and Custom, and nothing else', () =>
  {
    for (const preset of BUILTIN_PRESETS)
    {
      const guide = presetGuide(preset.op, preset.id)
      expect(guide, preset.id).not.toBeNull()
      expect(guide?.bestFor, preset.id).toMatch(/\.$/)
      expect(guide?.how, preset.id).toMatch(/\.$/)
    }
    expect(presetGuide('normalize', 'custom')).not.toBeNull()
    expect(presetGuide('boost', 'custom')).not.toBeNull()
    expect(presetGuide('convert', 'night')).toBeNull()
    expect(presetGuide('normalize', 'user-1')).toBeNull()
  })

  it('point only at presets that exist, and offer goals that each name a preset of their operation', () =>
  {
    for (const op of OPERATIONS)
    {
      expect(PRESET_GOALS[op].length, op).toBeGreaterThan(3)
      for (const goal of PRESET_GOALS[op])
      {
        expect(findPreset(goal.presetId)?.op, goal.goal).toBe(op)
      }
    }
    for (const preset of BUILTIN_PRESETS)
    {
      const pointer = presetGuide(preset.op, preset.id)?.instead
      if (pointer !== undefined)
      {
        expect(findPreset(pointer.presetId), preset.id).not.toBeNull()
        expect(pointer.presetId).not.toBe(preset.id)
      }
    }
  })

  it('send a movie with quiet dialogue to Night listening, and Night to dialog emphasis for 5.1', () =>
  {
    expect(PRESET_GOALS.normalize[0]).toEqual({ goal: 'A movie or show: quiet dialogue, loud action or music', presetId: 'night' })
    expect(presetGuide('normalize', 'night')?.tip?.action?.patch).toEqual({ field: 'downmix', value: 'dialog' })
    expect(presetGuide('normalize', 'film-r128s4')?.instead?.presetId).toBe('night')
  })

  it('use American spelling and no em dashes', () =>
  {
    const text = JSON.stringify({ goals: PRESET_GOALS, guides: BUILTIN_PRESETS.map((preset) => presetGuide(preset.op, preset.id)) })
    expect(text).not.toMatch(/—/)
    expect(text).not.toMatch(/\b(colour|behaviour|centre|catalogue|analyse|recognise)\b/i)
  })
})

describe('PresetGuideText', () =>
{
  it('renders the use, how it works, a pointer as text, and a tip without an action when nothing applies them', () =>
  {
    render(<PresetGuideText op="normalize" presetId="night" className="extra" />)
    const guide = document.querySelector('[data-preset-guide="night"]') as HTMLElement
    expect(guide).toHaveClass('extra')
    expect(guide).toHaveTextContent('Movies and shows where dialogue is too quiet')
    expect(guide).toHaveTextContent('Film and series (EBU R 128 s4)')
    expect(within(guide).queryByRole('button')).toBeNull()
    expect(guide).toHaveTextContent('center channel')
  })

  it('applies a same-operation pointer and a tip through their handlers', () =>
  {
    const use = vi.fn()
    const tip = vi.fn()
    render(<PresetGuideText op="normalize" presetId="night" onUsePreset={use} onTip={tip} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use Film and series (EBU R 128 s4)' }))
    expect(use).toHaveBeenCalledWith('film-r128s4')
    fireEvent.click(screen.getByRole('button', { name: 'Emphasize dialog' }))
    expect(tip).toHaveBeenCalledWith({ field: 'downmix', value: 'dialog' }, 'Downmix')
  })

  it('names a pointer of another operation with that operation, never as a button', () =>
  {
    render(<PresetGuideText op="boost" presetId="louder" onUsePreset={vi.fn()} />)
    const guide = document.querySelector('[data-preset-guide="louder"]') as HTMLElement
    expect(guide).toHaveTextContent('Normalize: Streaming (EBU R 128 s2)')
    expect(within(guide).queryByRole('button')).toBeNull()
  })

  it('renders nothing for a user preset', () =>
  {
    const { container } = render(<PresetGuideText op="normalize" presetId="user-late" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('GoalFinder', () =>
{
  it('lists each goal with its preset, marks the one in use, and chooses on press', () =>
  {
    const choose = vi.fn()
    render(<GoalFinder op="compress" current="target-25mb" onChoose={choose} layout="columns" className="extra" />)
    const list = screen.getByRole('list', { name: 'Compress goals' })
    expect(list).toHaveClass('extra')
    const fit = within(list).getByRole('button', { name: /Fit under 25 MB/ })
    expect(fit).toHaveAttribute('aria-current', 'true')
    expect(fit).toHaveTextContent('Target 25 MB, In use')
    expect(fit).toHaveClass('grid')
    const share = within(list).getByRole('button', { name: /Share or upload/ })
    expect(share).not.toHaveAttribute('aria-current')
    fireEvent.click(share)
    expect(choose).toHaveBeenCalledWith('web-1080p')
  })

  it('stacks the preset under its goal by default', () =>
  {
    render(<GoalFinder op="extract" current={null} onChoose={vi.fn()} />)
    expect(screen.getAllByRole('button')[0]).toHaveClass('flex-col')
  })
})
