/**
 * @module main/ffmpeg/download-facts
 * @description What first-run setup tells the user about the tested FFmpeg build before it downloads: how large the
 * download is and who publishes it. Reads the pin; never changes it.
 */

import type { FfmpegDownloadFacts } from '../../shared/ipc/api'
import { selectAssets, type PinnedBuilds } from './build'

const PUBLISHERS: ReadonlyArray<{ prefix: string; name: string }> = [
  { prefix: 'btbn-', name: 'BtbN FFmpeg Builds' },
  { prefix: 'gyan-', name: 'Gyan.dev' },
  { prefix: 'mriedl-', name: 'Martin Riedl' }
]

/** The publisher of an install folder name, or null for a name no pinned publisher uses. */
export function publisherOf(buildId: string): string | null
{
  return PUBLISHERS.find((entry) => buildId.startsWith(entry.prefix))?.name ?? null
}

/** The download size, publisher, and host of the primary build pinned for a host, or null when the pin has none. */
export function pinnedDownloadFacts(pin: PinnedBuilds, platform: NodeJS.Platform, arch: string): FfmpegDownloadFacts | null
{
  const assets = selectAssets(pin, platform, arch)?.primary ?? []
  if (assets.length === 0)
  {
    return null
  }
  const host = new URL(assets[0].url).hostname
  return {
    bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    publisher: publisherOf(assets[0].build) ?? host,
    host
  }
}
