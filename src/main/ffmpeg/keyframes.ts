/**
 * @module main/ffmpeg/keyframes
 * @description Where a file's video keyframes fall. FFprobe decodes only the keyframes of the first video stream
 * (`-skip_frame nokey`), so even a long file is read quickly, and prints one time per line.
 */

/** The FFprobe arguments that list the keyframe times of a file's first video stream. */
export function keyframeArgs(filePath: string): string[]
{
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=best_effort_timestamp_time',
    '-of', 'csv=p=0',
    filePath
  ]
}

/** The keyframe times in seconds from FFprobe's output, sorted, without repeats or unreadable lines. */
export function parseKeyframeTimes(stdout: string): number[]
{
  const times = new Set<number>()
  for (const line of stdout.split(/\r?\n/))
  {
    const field = line.split(',')[0]?.trim()
    if (!field)
    {
      continue
    }
    const value = Number(field)
    if (Number.isFinite(value) && value >= 0)
    {
      times.add(Math.round(value * 1000) / 1000)
    }
  }
  return [...times].sort((a, b) => a - b)
}
