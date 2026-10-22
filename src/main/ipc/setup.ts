/**
 * @module main/ipc/setup
 * @description IPC handlers first-run setup adds to the FFmpeg handlers in files.ts: the tested build's download size
 * and publisher, a folder picker for an FFmpeg already on the computer, and adopting that folder after the same
 * checks discovery runs. Also names why a setup download stopped, for the words setup shows.
 */

import { dialog, ipcMain } from 'electron'
import * as path from 'path'
import type { FfmpegFolderResult, SetupProblem, SetupProblemKind } from '../../shared/ipc/api'
import { pinnedDownloadFacts } from '../ffmpeg/download-facts'
import { adoptFfmpegFolder, exclusiveDialog, ffmpegInfo, parentWindowOf, pinnedBuilds } from './jobs-host'

const OFFLINE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
  'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
])

const ACCESS_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EROFS', 'EBUSY'])

function codeOf(err: unknown): string | null
{
  const own = (err as { code?: unknown } | null)?.code
  if (typeof own === 'string')
  {
    return own
  }
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof cause === 'string' ? cause : null
}

function statusOf(err: unknown, detail: string): number | null
{
  const own = (err as { status?: unknown } | null)?.status
  if (typeof own === 'number')
  {
    return own
  }
  const match = /\bstatus (\d{3})\b/.exec(detail)
  return match ? Number(match[1]) : null
}

function kindOf(code: string | null, status: number | null, detail: string): SetupProblemKind
{
  if (code === 'ENOSPC')
  {
    return 'disk-full'
  }
  if (code !== null && ACCESS_CODES.has(code))
  {
    return 'no-access'
  }
  if ((code !== null && OFFLINE_CODES.has(code)) || /getaddrinfo|socket hang up|fetch failed/i.test(detail))
  {
    return 'offline'
  }
  if (/stalled/i.test(detail))
  {
    return 'stalled'
  }
  if (/checksum/i.test(detail))
  {
    return 'checksum'
  }
  if (status === 404 || status === 410 || /could not be downloaded for/i.test(detail))
  {
    return 'unavailable'
  }
  if (status !== null)
  {
    return 'server'
  }
  if (/self-test|or newer is required|was not found at|could not be used/i.test(detail))
  {
    return 'rejected'
  }
  return 'unknown'
}

/** Why a setup download or install stopped, read from its error's code, HTTP status, and message. */
export function setupProblemOf(err: unknown): SetupProblem
{
  const detail = err instanceof Error ? err.message : String(err)
  const status = statusOf(err, detail)
  return { kind: kindOf(codeOf(err), status, detail), status, detail }
}

/** Register the setup handlers: download facts, the FFmpeg folder picker, and adopting a chosen folder. */
export function registerSetupIPC(): void
{
  ipcMain.handle('ffmpeg:downloadFacts', () => pinnedDownloadFacts(pinnedBuilds(), process.platform, process.arch))

  ipcMain.handle('ffmpeg:chooseFolder', async (event) =>
    exclusiveDialog<string | null>(null, async () =>
    {
      const win = parentWindowOf(event.sender)
      if (!win)
      {
        return null
      }
      const result = await dialog.showOpenDialog(win, { title: 'Choose the folder that holds FFmpeg', properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    }))

  ipcMain.handle('ffmpeg:adoptFolder', async (_event, folder: unknown): Promise<FfmpegFolderResult> =>
  {
    if (typeof folder !== 'string' || folder.length === 0 || !path.isAbsolute(folder))
    {
      return { status: 'refused', folder: String(folder ?? ''), reason: 'missing', version: null, failedTest: null }
    }
    const outcome = await adoptFfmpegFolder(folder)
    return outcome.adopted
      ? { status: 'adopted', info: ffmpegInfo() }
      : { status: 'refused', folder, reason: outcome.reason, version: outcome.version, failedTest: outcome.failedTest }
  })
}
