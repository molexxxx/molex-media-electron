/**
 * The keyframe listing: the FFprobe arguments read only keyframes of the first video stream, and the parser keeps
 * each readable time once, in order.
 */
import { describe, expect, it } from 'vitest'
import { keyframeArgs, parseKeyframeTimes } from '../../src/main/ffmpeg/keyframes'

describe('keyframe listing', () =>
{
  it('asks FFprobe for the keyframe times of the first video stream only', () =>
  {
    const args = keyframeArgs('C:\\media\\clip.mp4')
    expect(args).toEqual([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-of', 'csv=p=0',
      'C:\\media\\clip.mp4'
    ])
  })

  it('reads FFprobe output as measured: a trailing comma, blank lines, and Windows line ends', () =>
  {
    expect(parseKeyframeTimes('0.000000,\r\n\r\n1.000000\r\n2.000000\n\n3.000000\n')).toEqual([0, 1, 2, 3])
  })

  it('drops repeats and unreadable or negative times, and sorts the rest', () =>
  {
    expect(parseKeyframeTimes('2.5\nN/A\n1.25\n2.5\n-0.040\n\n')).toEqual([1.25, 2.5])
  })

  it('returns nothing for a file without video', () =>
  {
    expect(parseKeyframeTimes('')).toEqual([])
  })
})
