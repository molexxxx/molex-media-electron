/**
 * @module main/ffmpeg/folder
 * @description The builds a folder the user chose may hold: the folder itself, then its bin folder, since FFmpeg
 * archives unpack with the tools under bin.
 */

import { posix, win32 } from 'path'
import { executableName, type BuildCandidate } from './build'

/** The custom build candidates of a chosen folder, in the order they are tried. */
export function folderCandidates(folder: string, platform: NodeJS.Platform): BuildCandidate[]
{
  const join = platform === 'win32' ? win32.join : posix.join
  const at = (dir: string): BuildCandidate => ({
    source: 'custom',
    buildId: null,
    ffmpegPath: join(dir, executableName('ffmpeg', platform)),
    ffprobePath: join(dir, executableName('ffprobe', platform))
  })
  return [at(folder), at(join(folder, 'bin'))]
}
