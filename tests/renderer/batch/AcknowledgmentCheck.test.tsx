/**
 * The Review acknowledgment: its label states both counts and names the bin per volume, its description states
 * the room Review found, and the box reports changes without remembering anything itself.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PreflightReport, VolumeReport } from '../../../src/shared/jobs/types'
import
{
  AcknowledgmentCheck,
  acknowledgmentDescription,
  acknowledgmentLabel,
  binName,
  confirmFirstText,
  needsAcknowledgment,
  originalsByVolume,
  volumeName,
  volumeOf,
  type AcknowledgmentFacts
} from '../../../src/renderer/src/components/batch/summary/AcknowledgmentCheck'

const GB = 1_000_000_000

function volume(over: Partial<VolumeReport> = {}): VolumeReport
{
  return {
    volume: 'D:',
    kind: 'local',
    trash: 'available',
    trashBytesFree: 96 * GB,
    trashBytesNeeded: 9 * GB,
    volumeBytes: 2000 * GB,
    freeBytes: 412 * GB,
    estimatedBytes: 9 * GB,
    status: 'ok',
    ...over
  }
}

function facts(over: Partial<AcknowledgmentFacts> = {}): AcknowledgmentFacts
{
  return {
    originals: 20,
    overwrites: 0,
    originalsByVolume: [{ volume: 'D:', count: 20 }],
    keepOld: false,
    platform: 'win32',
    ...over
  }
}

function replaceJob(path: string, resolution: 'replace-original' | 'place' = 'replace-original'): PreflightReport['jobs'][number]
{
  return {
    jobId: path as never,
    inputsRev: 1,
    status: 'ready',
    issues: [],
    plan: { source: { path, size: 1, mtimeMs: 1 }, output: { resolution } } as never
  }
}

afterEach(() =>
{
  cleanup()
})

describe('volumes', () =>
{
  it('names a volume without its trailing separator', () =>
  {
    expect(volumeName('D:\\')).toBe('D:')
    expect(volumeName('/')).toBe('/')
    expect(volumeName('E:')).toBe('E:')
  })

  it('finds the longest report volume that holds a path, else the drive, share, or root', () =>
  {
    const volumes = [{ volume: 'D:\\' }, { volume: 'D:\\Mount\\' }]
    expect(volumeOf('d:/Mount/a.wav', volumes)).toBe('D:\\Mount')
    expect(volumeOf('D:\\Music\\a.wav', volumes)).toBe('D:')
    expect(volumeOf('e:\\a.wav', volumes)).toBe('E:')
    expect(volumeOf('\\\\nas\\media\\a.wav')).toBe('\\\\nas\\media')
    expect(volumeOf('//nas/media/a.wav')).toBe('\\\\nas\\media')
    expect(volumeOf('/home/a.wav')).toBe('/')
    expect(volumeOf('x', [{ volume: '' }])).toBe('/')
  })

  it('counts the originals a report replaces per source volume', () =>
  {
    const report = {
      volumes: [volume(), volume({ volume: 'E:' })],
      jobs: [replaceJob('D:\\a.wav'), replaceJob('E:\\b.wav'), replaceJob('D:\\c.wav'), replaceJob('D:\\d.wav', 'place'), { ...replaceJob('D:\\e.wav'), plan: null }]
    }
    expect(originalsByVolume(report)).toEqual([{ volume: 'D:', count: 2 }, { volume: 'E:', count: 1 }])
  })
})

describe('acknowledgmentLabel', () =>
{
  it('names the bin of the one volume', () =>
  {
    expect(acknowledgmentLabel(facts())).toBe('I understand that 20 originals go to the Recycle Bin on D: after their outputs verify.')
  })

  it('states both counts joined with "and"', () =>
  {
    expect(acknowledgmentLabel(facts({ overwrites: 3 })))
      .toBe('I understand that 20 originals go to the Recycle Bin on D: after their outputs verify and 3 existing files go to the Recycle Bin and are replaced.')
  })

  it('names each volume when the originals sit on several', () =>
  {
    const label = acknowledgmentLabel(facts({ originalsByVolume: [{ volume: 'D:', count: 14 }, { volume: 'E:', count: 6 }] }))
    expect(label).toBe('I understand that 20 originals go to the Recycle Bin (14 on D:, 6 on E:) after their outputs verify.')
  })

  it('states overwrites alone', () =>
  {
    expect(acknowledgmentLabel(facts({ originals: 0, overwrites: 3, originalsByVolume: [] })))
      .toBe('I understand that 3 existing files go to the Recycle Bin and are replaced.')
  })

  it('speaks of one original and one file in the singular', () =>
  {
    expect(acknowledgmentLabel(facts({ originals: 1, overwrites: 1, originalsByVolume: [{ volume: 'D:', count: 1 }] })))
      .toBe('I understand that 1 original goes to the Recycle Bin on D: after its output verifies and 1 existing file goes to the Recycle Bin and is replaced.')
  })

  it('says renamed with "Keep old files beside the new ones"', () =>
  {
    expect(acknowledgmentLabel(facts({ keepOld: true })))
      .toBe('I understand that 20 originals are renamed to name (original).ext and replaced by their outputs.')
    expect(acknowledgmentLabel(facts({ keepOld: true, originals: 1, overwrites: 2 })))
      .toBe('I understand that 1 original is renamed to name (original).ext and replaced by its output and 2 existing files stay as name (previous).ext and are replaced.')
    expect(acknowledgmentLabel(facts({ keepOld: true, originals: 0, overwrites: 1 })))
      .toBe('I understand that 1 existing file stays as name (previous).ext and is replaced.')
  })

  it('names the Trash without volumes outside Windows', () =>
  {
    expect(binName('darwin')).toBe('the Trash')
    expect(acknowledgmentLabel(facts({ platform: 'linux', overwrites: 2 })))
      .toBe('I understand that 20 originals go to the Trash after their outputs verify and 2 existing files go to the Trash and are replaced.')
  })

  it('leaves the volume out when none is known', () =>
  {
    expect(acknowledgmentLabel(facts({ originalsByVolume: [] }))).toBe('I understand that 20 originals go to the Recycle Bin after their outputs verify.')
  })
})

describe('confirmFirstText and needsAcknowledgment', () =>
{
  it('words the Ctrl+Enter refusal', () =>
  {
    expect(confirmFirstText(facts())).toBe('Confirm that 20 originals go to the Recycle Bin on D: first.')
    expect(confirmFirstText(facts({ keepOld: true }))).toBe('Confirm that 20 originals are renamed to name (original).ext first.')
  })

  it('calls for the box only when originals are affected or files replaced', () =>
  {
    expect(needsAcknowledgment({ originals: 0, overwrites: 0 })).toBe(false)
    expect(needsAcknowledgment({ originals: 0, overwrites: 1 })).toBe(true)
    expect(needsAcknowledgment({ originals: 2, overwrites: 0 })).toBe(true)
  })
})

describe('acknowledgmentDescription', () =>
{
  it('states the room Review found on the one volume', () =>
  {
    expect(acknowledgmentDescription(facts(), [volume()])).toBe('The Recycle Bin on D: has room for about 96 GB. Windows can empty it automatically.')
  })

  it('lists the room of each receiving volume', () =>
  {
    const volumes = [volume(), volume({ volume: 'E:\\', trashBytesFree: 12 * GB, trashBytesNeeded: 0 }), volume({ volume: 'F:', trashBytesNeeded: 0 })]
    const text = acknowledgmentDescription(facts({ originalsByVolume: [{ volume: 'D:', count: 14 }, { volume: 'E:', count: 6 }] }), volumes)
    expect(text).toBe('The Recycle Bin has room for about 96 GB on D: and about 12 GB on E:. Windows can empty it automatically.')
  })

  it('falls back when no room is known, and words the Trash and kept files', () =>
  {
    expect(acknowledgmentDescription(facts(), [volume({ trashBytesFree: null })])).toBe('Windows can empty the Recycle Bin automatically.')
    expect(acknowledgmentDescription(facts(), [volume({ trash: 'unavailable' })])).toBe('Windows can empty the Recycle Bin automatically.')
    expect(acknowledgmentDescription(facts({ platform: 'darwin' }), [volume()])).toBe('The Trash can be emptied automatically.')
    expect(acknowledgmentDescription(facts({ keepOld: true }), [volume()])).toBe('Nothing goes to the Recycle Bin; the old files stay beside the new ones.')
  })
})

describe('AcknowledgmentCheck', () =>
{
  it('labels the box with the counts and describes it with the room', () =>
  {
    render(<AcknowledgmentCheck facts={facts({ overwrites: 3 })} volumes={[volume()]} checked={false} onChange={() => undefined} />)
    const box = screen.getByRole('checkbox', { name: /20 originals go to the Recycle Bin on D:.*3 existing files/ })
    expect(box).not.toBeChecked()
    expect(box).toHaveAccessibleDescription('The Recycle Bin on D: has room for about 96 GB. Windows can empty it automatically.')
  })

  it('reports a change and leaves the checked state to its owner', () =>
  {
    const onChange = vi.fn()
    const { rerender } = render(<AcknowledgmentCheck facts={facts()} volumes={[volume()]} checked={false} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<AcknowledgmentCheck facts={facts()} volumes={[volume()]} checked onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('shows why a count change unchecked it and describes the box with that reason', () =>
  {
    const notice = 'The number of originals changed to 22; confirm again.'
    render(<AcknowledgmentCheck facts={facts({ originals: 22 })} volumes={[volume()]} checked={false} notice={notice} onChange={() => undefined} />)
    expect(screen.getByText(notice)).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toHaveAccessibleDescription(`${notice} The Recycle Bin on D: has room for about 96 GB. Windows can empty it automatically.`)
  })

  it('hands its ref to the checkbox for Ctrl+Enter', () =>
  {
    const ref = React.createRef<HTMLInputElement>()
    render(<AcknowledgmentCheck facts={facts()} volumes={[volume()]} checked={false} onChange={() => undefined} ref={ref} />)
    expect(ref.current).toBe(screen.getByRole('checkbox'))
  })
})
